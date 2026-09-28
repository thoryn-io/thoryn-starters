using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.IdentityModel.Tokens;
using Xunit;

namespace ThorynStarter.Tests;

public sealed class AppFixture : IAsyncLifetime
{
    public const string ClientId = "app-starter-test";
    public FakeIssuer Fake { get; private set; } = null!;
    public string Base { get; private set; } = "";
    private WebApplication _app = null!;

    public async ValueTask InitializeAsync()
    {
        Fake = await FakeIssuer.StartAsync(ClientId);
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        Base = $"http://127.0.0.1:{port}";
        _app = StarterApp.Build([], new Dictionary<string, string?>
        {
            ["OIDC_ISSUER"] = Fake.Issuer,
            ["OIDC_CLIENT_ID"] = ClientId,
            ["PORT"] = port.ToString(),
            ["APP_BASE_URL"] = Base,
            ["Logging:LogLevel:Default"] = "Warning",
        });
        await _app.StartAsync();
    }

    public async ValueTask DisposeAsync()
    {
        await _app.DisposeAsync();
        await Fake.DisposeAsync();
    }
}

/// <summary>
/// The whole app against an in-process fake issuer: the code flow with PKCE, the profile page's call to the
/// protected API, logout, and every way the API must refuse a token.
/// </summary>
public sealed class StarterAppTests(AppFixture f) : IClassFixture<AppFixture>
{
    private readonly HttpClient _http = new(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false });

    private async Task<HttpResponseMessage> Get(string path, string? cookie = null, string? bearer = null)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, path.StartsWith("http") ? path : f.Base + path);
        if (cookie is not null) req.Headers.Add("Cookie", cookie);
        if (bearer is not null) req.Headers.Add("Authorization", "Bearer " + bearer);
        return await _http.SendAsync(req, TestContext.Current.CancellationToken);
    }

    private static string Cookies(HttpResponseMessage resp, string? previous = null)
    {
        var jar = new Dictionary<string, string>();
        foreach (var c in (previous ?? "").Split("; ", StringSplitOptions.RemoveEmptyEntries)) jar[c.Split('=')[0]] = c;
        if (resp.Headers.TryGetValues("Set-Cookie", out var set))
            foreach (var c in set.Select(s => s.Split(';')[0])) jar[c.Split('=')[0]] = c;
        return string.Join("; ", jar.Values.Where(c => !c.EndsWith('=')));
    }

    private static Uri Location(HttpResponseMessage resp) => resp.Headers.Location!;

    /// <summary>Drive the code flow like a browser; returns the signed-in cookies.</summary>
    private async Task<string> SignIn()
    {
        var login = await Get("/login");
        Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);
        var (code, state) = f.Fake.Authorize(Location(login));
        var cookies = Cookies(login);
        var cb = await Get($"/callback?code={code}&state={Uri.EscapeDataString(state)}", cookies);
        Assert.Equal(HttpStatusCode.Redirect, cb.StatusCode);
        Assert.Equal("/profile", Location(cb).OriginalString);
        return Cookies(cb, cookies);
    }

    [Fact]
    public async Task Login_redirects_to_authorize_with_PKCE_state_and_nonce()
    {
        var resp = await Get("/login");
        Assert.Equal(HttpStatusCode.Redirect, resp.StatusCode);
        var loc = Location(resp);
        Assert.Equal(f.Fake.Issuer + "/oauth2/authorize", loc.GetLeftPart(UriPartial.Path));
        var q = QueryHelpers.ParseQuery(loc.Query);
        Assert.Equal("code", q["response_type"]);
        Assert.Equal(AppFixture.ClientId, q["client_id"]);
        Assert.Equal(f.Base + "/callback", q["redirect_uri"]);
        Assert.Equal("S256", q["code_challenge_method"]);
        Assert.Matches("^[A-Za-z0-9_-]{43}$", q["code_challenge"].ToString());
        Assert.False(string.IsNullOrEmpty(q["state"]));
        Assert.False(string.IsNullOrEmpty(q["nonce"]));
        Assert.All(resp.Headers.GetValues("Set-Cookie"), c =>
        {
            Assert.Contains("httponly", c, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("samesite=lax", c, StringComparison.OrdinalIgnoreCase);
        });
    }

    [Fact]
    public async Task The_code_flow_signs_in_and_the_profile_shows_the_protected_API_result()
    {
        var profile = await Get("/profile", await SignIn());
        Assert.Equal(HttpStatusCode.OK, profile.StatusCode);
        var html = await profile.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        Assert.Contains("You are signed in as <strong>ada@example.com</strong>", html);
        Assert.Matches("id=\"api-result\">[^<]*&quot;client_id&quot;:&quot;" + AppFixture.ClientId + "&quot;", html);
    }

    [Fact]
    public async Task An_ID_token_signed_with_RS256_is_refused_at_the_callback()
    {
        f.Fake.IdTokenAlg = SecurityAlgorithms.RsaSha256;
        try
        {
            var login = await Get("/login");
            var (code, state) = f.Fake.Authorize(Location(login));
            var cb = await Get($"/callback?code={code}&state={Uri.EscapeDataString(state)}", Cookies(login));
            Assert.NotEqual("/profile", cb.Headers.Location?.OriginalString);
            Assert.DoesNotContain(cb.Headers.TryGetValues("Set-Cookie", out var set) ? set : [], c => c.StartsWith("starter.session="));
        }
        finally
        {
            f.Fake.IdTokenAlg = SecurityAlgorithms.EcdsaSha256;
        }
    }

    [Fact]
    public async Task A_callback_with_a_foreign_state_is_refused()
    {
        var login = await Get("/login");
        var (code, _) = f.Fake.Authorize(Location(login));
        var cb = await Get($"/callback?code={code}&state=forged", Cookies(login));
        Assert.NotEqual("/profile", cb.Headers.Location?.OriginalString);
    }

    [Fact]
    public async Task The_profile_without_a_session_redirects_to_login()
    {
        var resp = await Get("/profile");
        Assert.Equal(HttpStatusCode.Redirect, resp.StatusCode);
        Assert.Equal("/login", Location(resp).AbsolutePath);
    }

    [Fact]
    public async Task Logout_ends_the_session_through_the_end_session_endpoint()
    {
        var cookies = await SignIn();
        var profile = await Get("/profile", cookies);
        cookies = Cookies(profile, cookies);
        var html = await profile.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        var m = Regex.Match(html, "<input type=\"hidden\" name=\"([^\"]+)\" value=\"([^\"]+)\">");
        Assert.True(m.Success, "the sign-out form carries an antiforgery token");

        using var req = new HttpRequestMessage(HttpMethod.Post, f.Base + "/logout")
        {
            Content = new FormUrlEncodedContent(new Dictionary<string, string> { [m.Groups[1].Value] = WebUtility.HtmlDecode(m.Groups[2].Value) }),
        };
        req.Headers.Add("Cookie", cookies);
        var logout = await _http.SendAsync(req, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.Redirect, logout.StatusCode);
        var loc = Location(logout);
        Assert.Equal(f.Fake.Issuer + "/connect/logout", loc.GetLeftPart(UriPartial.Path));
        var q = QueryHelpers.ParseQuery(loc.Query);
        Assert.False(string.IsNullOrEmpty(q["id_token_hint"]));
        Assert.Equal(f.Base + "/signed-out", q["post_logout_redirect_uri"]);
        Assert.Equal(HttpStatusCode.Redirect, (await Get("/profile", cookies)).StatusCode);
    }

    [Fact]
    public async Task Logout_without_the_antiforgery_token_is_refused()
    {
        var cookies = await SignIn();
        using var req = new HttpRequestMessage(HttpMethod.Post, f.Base + "/logout") { Content = new FormUrlEncodedContent([]) };
        req.Headers.Add("Cookie", cookies);
        var resp = await _http.SendAsync(req, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.Forbidden, resp.StatusCode);
    }

    [Fact]
    public async Task The_API_accepts_a_valid_access_token()
    {
        var resp = await Get("/api/me", bearer: f.Fake.AccessToken());
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        Assert.Contains("\"sub\":\"user-1\"", body);
        Assert.Contains($"\"client_id\":\"{AppFixture.ClientId}\"", body);
    }

    public static TheoryData<string> BadTokens => ["none", "RS256", "typ JWT", "foreign issuer", "foreign audience", "expired", "another client", "garbage"];

    [Theory]
    [MemberData(nameof(BadTokens))]
    public async Task The_API_refuses_a_bad_token(string kind)
    {
        var token = kind switch
        {
            "none" => null,
            "RS256" => f.Fake.AccessToken(alg: SecurityAlgorithms.RsaSha256),
            "typ JWT" => f.Fake.AccessToken(typ: "JWT"),
            "foreign issuer" => f.Fake.AccessToken(iss: "https://evil.example"),
            "foreign audience" => f.Fake.AccessToken(aud: "https://other.example"),
            "expired" => f.Fake.AccessToken(expires: DateTime.UtcNow.AddMinutes(-10)),
            "another client" => f.Fake.AccessToken(clientId: "someone-else"),
            _ => "not.a.jwt",
        };
        var resp = await Get("/api/me", bearer: token);
        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
        Assert.StartsWith("Bearer", resp.Headers.WwwAuthenticate.ToString());
    }

    [Fact]
    public async Task Health_answers_ok()
    {
        Assert.Equal("ok", await (await Get("/health")).Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
    }
}
