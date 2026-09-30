namespace ThorynStarter;

/// <summary>
/// Reads KEY=value lines from .env (written by <c>node .thoryn/app-env.mjs --write .env</c>) so that
/// <c>dotnet run</c> works with one command. Real environment variables win.
/// </summary>
public static class DotEnv
{
    /// <summary>The nearest .env at or above [start] (dotnet run starts in src/StarterApp; .env sits at the repo root).</summary>
    public static string? Find(string start)
    {
        for (var dir = new DirectoryInfo(start); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, ".env");
            if (File.Exists(candidate)) return candidate;
            if (Directory.Exists(Path.Combine(dir.FullName, ".git")) || File.Exists(Path.Combine(dir.FullName, "global.json"))) break;
        }
        return null;
    }

    public static IDictionary<string, string?> Read(string? path)
    {
        var values = new Dictionary<string, string?>();
        if (path is null || !File.Exists(path)) return values;
        foreach (var raw in File.ReadAllLines(path))
        {
            var line = raw.Trim();
            if (line.Length == 0 || line.StartsWith('#')) continue;
            var eq = line.IndexOf('=');
            if (eq <= 0) continue;
            var key = line[..eq].Trim();
            if (Environment.GetEnvironmentVariable(key) is null) values[key] = line[(eq + 1)..].Trim();
        }
        return values;
    }
}
