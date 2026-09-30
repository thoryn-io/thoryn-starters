using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace ThorynStarter.Tests;

/// <summary>
/// A minimal in-process OpenID provider: discovery, JWKS, authorize bookkeeping and a token endpoint that
/// really checks PKCE. Tokens are signed like the platform signs them (ES256; access token typ at+jwt with
/// aud = [issuer] and a client_id claim). An RSA key is published too, so a test can prove a validly signed
/// RS256 token is still refused.
/// </summary>
public sealed class FakeIssuer : IAsyncDisposable
{
    private readonly WebApplication _app;
    private readonly ECDsaSecurityKey _ec = new(ECDsa.Create(ECCurve.NamedCurves.nistP256)) { KeyId = "ec-1" };
    private readonly RsaSecurityKey _rsa = new(RSA.Create(2048)) { KeyId = "rsa-1" };
    private readonly ConcurrentDictionary<string, (string Challenge, string Nonce)> _codes = new();
    private readonly string _clientId;

    public string Issuer { get; private set; } = "";
    public string IdTokenAlg { get; set; } = SecurityAlgorithms.EcdsaSha256;

    private FakeIssuer(string clientId)
    {
        _clientId = clientId;
        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Logging.SetMinimumLevel(LogLevel.Warning);
        _app = builder.Build();
        _app.MapGet("/dev/.well-known/openid-configuration", () => Results.Json(new Dictionary<string, object>
        {
            ["issuer"] = Issuer,
            ["authorization_endpoint"] = Issuer + "/oauth2/authorize",
            ["token_endpoint"] = Issuer + "/oauth2/token",
            ["jwks_uri"] = Issuer + "/oauth2/jwks",
            ["end_session_endpoint"] = Issuer + "/connect/logout",
            ["response_types_supported"] = new[] { "code" },
            ["subject_types_supported"] = new[] { "public" },
            ["id_token_signing_alg_values_supported"] = new[] { "ES256" },
            ["code_challenge_methods_supported"] = new[] { "S256" },
        }));
        _app.MapGet("/dev/oauth2/jwks", () =>
        {
            var ec = JsonWebKeyConverter.ConvertFromECDsaSecurityKey(_ec);
            ec.Use = "sig"; ec.Alg = "ES256";
            var rsa = JsonWebKeyConverter.ConvertFromRSASecurityKey(_rsa);
            rsa.Use = "sig"; rsa.Alg = "RS256";
            return Results.Json(new { keys = new object[] { Public(ec), Public(rsa) } });
        });
        _app.MapPost("/dev/oauth2/token", async (HttpRequest req) =>
        {
            var form = await req.ReadFormAsync();
            if (!_codes.TryRemove(form["code"].ToString(), out var grant)
                || grant.Challenge != Base64UrlEncoder.Encode(SHA256.HashData(Encoding.ASCII.GetBytes(form["code_verifier"].ToString())))
                || form["client_id"] != _clientId)
            {
                return Results.Json(new { error = "invalid_grant" }, statusCode: 400);
            }
            return Results.Json(new
            {
                token_type = "Bearer",
                expires_in = 300,
                id_token = IdToken(grant.Nonce),
                access_token = AccessToken(),
            });
        });
    }

    public static async Task<FakeIssuer> StartAsync(string clientId)
    {
        var fake = new FakeIssuer(clientId);
        await fake._app.StartAsync();
        var address = fake._app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
        fake.Issuer = address.TrimEnd('/') + "/dev";
        return fake;
    }

    /// <summary>Record what /oauth2/authorize would have seen; returns the code and state for the callback.</summary>
    public (string Code, string State) Authorize(Uri authorizeUrl)
    {
        var q = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(authorizeUrl.Query);
        var code = Guid.NewGuid().ToString("N");
        _codes[code] = (q["code_challenge"].ToString(), q["nonce"].ToString());
        return (code, q["state"].ToString());
    }

    public string IdToken(string nonce) => Sign(new Dictionary<string, object>
    {
        ["iss"] = Issuer, ["aud"] = _clientId, ["sub"] = "user-1", ["email"] = "ada@example.com", ["nonce"] = nonce,
    }, IdTokenAlg, "JWT", DateTime.UtcNow.AddMinutes(5));

    public string AccessToken(string alg = SecurityAlgorithms.EcdsaSha256, string typ = "at+jwt", string? iss = null,
        string? aud = null, DateTime? expires = null, string? clientId = null) => Sign(new Dictionary<string, object>
    {
        ["iss"] = iss ?? Issuer, ["aud"] = new[] { aud ?? Issuer }, ["sub"] = "user-1",
        ["client_id"] = clientId ?? _clientId, ["scope"] = "openid profile email", ["jti"] = Guid.NewGuid().ToString(),
    }, alg, typ, expires ?? DateTime.UtcNow.AddMinutes(5));

    private string Sign(Dictionary<string, object> claims, string alg, string typ, DateTime expires)
    {
        SecurityKey key = alg == SecurityAlgorithms.RsaSha256 ? _rsa : _ec;
        var now = DateTime.UtcNow;
        return new JsonWebTokenHandler { SetDefaultTimesOnTokenCreation = false }.CreateToken(new SecurityTokenDescriptor
        {
            Claims = claims,
            IssuedAt = expires < now ? expires.AddMinutes(-5) : now,
            NotBefore = expires < now ? expires.AddMinutes(-5) : now,
            Expires = expires,
            TokenType = typ,
            SigningCredentials = new SigningCredentials(key, alg),
        });
    }

    private static object Public(JsonWebKey k) => k.Kty == "EC"
        ? new { kty = k.Kty, crv = k.Crv, x = k.X, y = k.Y, kid = k.Kid, use = k.Use, alg = k.Alg }
        : new { kty = k.Kty, n = k.N, e = k.E, kid = k.Kid, use = k.Use, alg = k.Alg };

    public async ValueTask DisposeAsync() => await _app.DisposeAsync();
}
