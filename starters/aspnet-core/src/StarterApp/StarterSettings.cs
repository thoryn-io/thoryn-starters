namespace ThorynStarter;

/// <summary>
/// Everything the app needs from Thoryn, read from the environment (and from .env, see <see cref="DotEnv"/>).
/// </summary>
public sealed record StarterSettings(string Issuer, string ClientId, string Audience, string BaseUrl, string ListenUrl, bool CookieSecure)
{
    public static StarterSettings From(IConfiguration config)
    {
        string Required(string key) => config[key] is { Length: > 0 } v
            ? v.Trim()
            : throw new InvalidOperationException(
                $"{key} is not set. Provision the sandbox and write .env first: " +
                "thoryn provision apply --file .thoryn/provision.yaml && node .thoryn/app-env.mjs --write .env");

        var issuer = Required("OIDC_ISSUER").TrimEnd('/');
        var port = config["PORT"] is { Length: > 0 } p ? p : "8080";
        var host = config["HOST"] is { Length: > 0 } h ? h : "127.0.0.1";
        var baseUrl = (config["APP_BASE_URL"] is { Length: > 0 } b ? b : $"http://127.0.0.1:{port}").TrimEnd('/');
        return new StarterSettings(
            Issuer: issuer,
            ClientId: Required("OIDC_CLIENT_ID"),
            // Thoryn lists its issuer in every access token's `aud` (RFC 9068 §2.2). Override when your API is
            // registered as its own resource.
            Audience: config["OIDC_AUDIENCE"] is { Length: > 0 } a ? a.Trim() : issuer,
            BaseUrl: baseUrl,
            ListenUrl: $"http://{host}:{port}",
            // Secure cookies whenever the app is served over https; plain http is for loopback development only.
            CookieSecure: config["COOKIE_SECURE"] is { Length: > 0 } c ? c == "true" : baseUrl.StartsWith("https://", StringComparison.Ordinal));
    }
}
