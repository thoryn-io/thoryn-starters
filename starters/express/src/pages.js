// Tiny server-rendered pages. Every value is HTML-escaped.
export const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function layout(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<main>
<h1>${esc(title)}</h1>
${body}
</main>
</body>
</html>`;
}

export function homePage(user) {
  if (user) {
    return layout(
      "Thoryn starter",
      `<p>Signed in as <strong>${esc(user.email ?? user.sub)}</strong>.</p>
<p><a href="/profile">Your profile</a></p>`,
    );
  }
  return layout(
    "Thoryn starter",
    `<p>An Express app that signs users in with Thoryn and protects its own API.</p>
<p><a class="button" href="/login">Sign in with Thoryn</a></p>`,
  );
}

export function profilePage(user, apiResult) {
  const rows = Object.entries(user)
    .filter(([k]) => !["nonce", "at_hash", "c_hash", "sid"].includes(k))
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</td></tr>`)
    .join("\n");
  return layout(
    "Profile",
    `<p class="ok">You are signed in as <strong>${esc(user.email ?? user.sub)}</strong>.</p>
<h2>ID token claims</h2>
<table>${rows}</table>
<h2>Protected API</h2>
<p>The server called <code>GET /api/me</code> with your access token:</p>
<pre id="api-result">${esc(apiResult)}</pre>
<form method="post" action="/logout"><button type="submit">Sign out</button></form>`,
  );
}

export function errorPage(message) {
  return layout("Sign-in failed", `<p class="error">${esc(message)}</p><p><a href="/">Back</a></p>`);
}
