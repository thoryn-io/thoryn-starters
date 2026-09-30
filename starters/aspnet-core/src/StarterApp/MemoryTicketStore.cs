using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.Extensions.Caching.Memory;

namespace ThorynStarter;

/// <summary>
/// Keeps the authentication ticket (claims and tokens) on the server; the browser's cookie only carries an
/// opaque key. Single-process: use a distributed store (for example Redis) before running several instances.
/// </summary>
public sealed class MemoryTicketStore(IMemoryCache cache) : ITicketStore
{
    private static readonly TimeSpan Lifetime = TimeSpan.FromHours(8);

    public Task<string> StoreAsync(AuthenticationTicket ticket)
    {
        var key = "ticket-" + Guid.NewGuid().ToString("N");
        cache.Set(key, ticket, Lifetime);
        return Task.FromResult(key);
    }

    public Task RenewAsync(string key, AuthenticationTicket ticket)
    {
        cache.Set(key, ticket, Lifetime);
        return Task.CompletedTask;
    }

    public Task<AuthenticationTicket?> RetrieveAsync(string key) =>
        Task.FromResult(cache.TryGetValue(key, out AuthenticationTicket? ticket) ? ticket : null);

    public Task RemoveAsync(string key)
    {
        cache.Remove(key);
        return Task.CompletedTask;
    }
}
