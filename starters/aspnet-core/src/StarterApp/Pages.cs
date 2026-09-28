using System.Net;
using System.Security.Claims;

namespace ThorynStarter;

/// <summary>Tiny server-rendered pages. Every value is HTML-encoded.</summary>
public static class Pages
{
    private static readonly HashSet<string> HiddenClaims = ["nonce", "at_hash", "c_hash", "sid"];

    private static string E(string? s) => WebUtility.HtmlEncode(s ?? "");

    public static string Name(ClaimsPrincipal user) => user.FindFirstValue("email") ?? user.FindFirstValue("sub") ?? "you";

    public static string Home(string? signedInAs) => signedInAs is not null
        ? Layout("Thoryn starter", $"<p>Signed in as <strong>{E(signedInAs)}</strong>.</p>\n<p><a href=\"/profile\">Your profile</a></p>")
        : Layout("Thoryn starter",
            "<p>An ASP.NET Core app that signs users in with Thoryn and protects its own API.</p>\n" +
            "<p><a class=\"button\" href=\"/login\">Sign in with Thoryn</a></p>");

    public static string Profile(ClaimsPrincipal user, string apiResult, string csrfField, string csrfToken)
    {
        var rows = string.Join("\n", user.Claims
            .Where(c => !HiddenClaims.Contains(c.Type))
            .OrderBy(c => c.Type, StringComparer.Ordinal)
            .Select(c => $"<tr><th>{E(c.Type)}</th><td>{E(c.Value)}</td></tr>"));
        return Layout("Profile",
            $"<p class=\"ok\">You are signed in as <strong>{E(Name(user))}</strong>.</p>\n" +
            $"<h2>ID token claims</h2>\n<table>{rows}</table>\n" +
            "<h2>Protected API</h2>\n<p>The server called <code>GET /api/me</code> with your access token:</p>\n" +
            $"<pre id=\"api-result\">{E(apiResult)}</pre>\n" +
            $"<form method=\"post\" action=\"/logout\"><input type=\"hidden\" name=\"{E(csrfField)}\" value=\"{E(csrfToken)}\">" +
            "<button type=\"submit\">Sign out</button></form>");
    }

    private static string Layout(string title, string body) => $"""
        <!doctype html>
        <html lang="en">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>{E(title)}</title>
        <link rel="stylesheet" href="/style.css">
        </head>
        <body>
        <main>
        <h1>{E(title)}</h1>
        {body}
        </main>
        </body>
        </html>
        """;
}
