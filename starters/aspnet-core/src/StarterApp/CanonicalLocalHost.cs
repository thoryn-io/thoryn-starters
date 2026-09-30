namespace ThorynStarter;

/// <summary>
/// Local development: one canonical host. Sign-in keeps its cookies on the host the browser used, and Thoryn
/// sends the browser back to the configured base URL, so a sign-in started on http://localhost:8080 while the
/// base URL is http://127.0.0.1:8080 would lose its correlation cookie. When the base URL is a loopback
/// address and a request arrives on ANOTHER loopback host, a GET is sent to the same path and query on the
/// base URL (other methods get 400), so either address simply works.
///
/// The redirect target is built ONLY from the configured base URL (plus the request's path and query, which
/// cannot change the host); the Host header is only compared, never echoed. A deployed app (a non-loopback
/// base URL) is never redirected, so a proxy that rewrites the Host header cannot cause a redirect loop.
/// </summary>
public static class CanonicalLocalHost
{
    private static readonly HashSet<string> Loopback = new(StringComparer.OrdinalIgnoreCase)
    {
        "localhost", "127.0.0.1", "[::1]", "::1",
    };

    /// <summary>
    /// <c>null</c>: pass the request through. Empty string: refuse it (400). Otherwise: the redirect target.
    /// </summary>
    public static string? Decide(string baseUrl, string method, string? requestHost, string pathAndQuery)
    {
        var configured = new Uri(baseUrl);
        if (!Loopback.Contains(configured.Host)) return null;
        if (string.IsNullOrEmpty(requestHost)
            || !Uri.TryCreate("http://" + requestHost, UriKind.Absolute, out var requested)
            || !Loopback.Contains(requested.Host))
            return null;
        if (string.Equals(requested.Host, configured.Host, StringComparison.OrdinalIgnoreCase) && requested.Port == configured.Port)
            return null;
        if (!HttpMethods.IsGet(method) && !HttpMethods.IsHead(method)) return "";
        // pathAndQuery starts with "/", so the target always stays on the base URL's origin.
        return configured.GetLeftPart(UriPartial.Authority) + pathAndQuery;
    }

    public static IApplicationBuilder UseCanonicalLocalHost(this IApplicationBuilder app, string baseUrl) =>
        app.Use(async (context, next) =>
        {
            var request = context.Request;
            var target = Decide(baseUrl, request.Method, request.Host.Value, request.PathBase + request.Path + request.QueryString);
            if (target is null)
            {
                await next(context);
            }
            else if (target.Length == 0)
            {
                context.Response.StatusCode = StatusCodes.Status400BadRequest;
                await context.Response.WriteAsync($"Use {baseUrl}: this app's base URL.\n");
            }
            else
            {
                context.Response.Redirect(target);
            }
        });
}
