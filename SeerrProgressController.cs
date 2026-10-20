using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.SeerrProgress;

[ApiController]
[Route("SeerrProgress")]
public class SeerrProgressController : ControllerBase
{
    // Status endpoint cache
    private static readonly SemaphoreSlim Gate = new(1, 1);
    private static DateTime _cachedAt = DateTime.MinValue;
    private static List<object> _cache = new();

    // Requests endpoint caches
    private static readonly ConcurrentDictionary<string, (int SeerrId, DateTime At)> UserMap = new();
    private static readonly ConcurrentDictionary<string, (string? Title, string? Year, string? Poster)> MediaInfo = new();
    private static readonly ConcurrentDictionary<int, (DateTime At, List<object> Data)> RequestCache = new();

    private readonly IHttpClientFactory _http;

    private sealed class Agg
    {
        public double Size;
        public double Left;
        public int Count;
        public string? TimeLeft;
        public string? Status;
    }

    private sealed class Row
    {
        public int Id;
        public string Type = "";
        public int TmdbId;
        public int ReqStatus;
        public int MediaStatus;
        public string? CreatedAt;
        public bool Is4k;
        public List<int> Seasons = new();
        public double? Percent;
        public string? TimeLeft;
        public bool HasDownload;
    }

    public SeerrProgressController(IHttpClientFactory http)
    {
        _http = http;
    }

    // ---------------------------------------------------------------------
    // GET /SeerrProgress/Status : progress of everything currently downloading
    // ---------------------------------------------------------------------
    [HttpGet("Status")]
    [Authorize]
    [Produces("application/json")]
    public async Task<ActionResult<IEnumerable<object>>> GetStatus(CancellationToken ct)
    {
        var cfg = Plugin.Instance?.Configuration;
        if (cfg is null || string.IsNullOrWhiteSpace(cfg.SeerrUrl) || string.IsNullOrWhiteSpace(cfg.ApiKey))
        {
            return Ok(new List<object>());
        }

        await Gate.WaitAsync(ct);
        try
        {
            if (DateTime.UtcNow - _cachedAt < TimeSpan.FromSeconds(4))
            {
                return Ok(_cache);
            }

            using var doc = await SeerrGet("/request?take=100&filter=processing", ct);
            var byMedia = new Dictionary<string, object>();

            if (doc is not null && doc.RootElement.TryGetProperty("results", out var results))
            {
                foreach (var r in results.EnumerateArray())
                {
                    if (!r.TryGetProperty("media", out var media)) continue;
                    if (!media.TryGetProperty("tmdbId", out var tmdbEl) || tmdbEl.ValueKind != JsonValueKind.Number) continue;

                    var tmdbId = tmdbEl.GetInt32();
                    var type = media.TryGetProperty("mediaType", out var t) ? t.GetString() ?? "" : "";
                    var key = $"{type}:{tmdbId}";
                    if (byMedia.ContainsKey(key)) continue; // several requests (seasons) share one media

                    double size = 0, left = 0;
                    var groups = new Dictionary<string, Agg>();
                    if (media.TryGetProperty("downloadStatus", out var ds) && ds.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var d in ds.EnumerateArray())
                        {
                            double dSize = d.TryGetProperty("size", out var s) && s.ValueKind == JsonValueKind.Number ? s.GetDouble() : 0;
                            double dLeft = d.TryGetProperty("sizeLeft", out var sl) && sl.ValueKind == JsonValueKind.Number ? sl.GetDouble() : 0;
                            size += dSize;
                            left += dLeft;

                            // Sonarr lists a season pack once per episode; group by release title.
                            var title = d.TryGetProperty("title", out var ti) && ti.ValueKind == JsonValueKind.String ? ti.GetString() ?? "Unknown" : "Unknown";
                            if (!groups.TryGetValue(title, out var g))
                            {
                                g = new Agg
                                {
                                    TimeLeft = d.TryGetProperty("timeLeft", out var tl) && tl.ValueKind == JsonValueKind.String ? tl.GetString() : null,
                                    Status = d.TryGetProperty("status", out var st) && st.ValueKind == JsonValueKind.String ? st.GetString() : null
                                };
                                groups[title] = g;
                            }

                            g.Size += dSize;
                            g.Left += dLeft;
                            g.Count++;
                        }
                    }

                    var items = new List<object>();
                    foreach (var kv in groups)
                    {
                        if (items.Count >= 20) break;
                        items.Add(new
                        {
                            title = kv.Key,
                            percent = kv.Value.Size > 0 ? (double?)Math.Round((1 - kv.Value.Left / kv.Value.Size) * 100, 1) : null,
                            timeLeft = kv.Value.TimeLeft,
                            status = kv.Value.Status,
                            count = kv.Value.Count
                        });
                    }

                    double? percent = size > 0 ? Math.Round((1 - left / size) * 100, 1) : null;
                    byMedia[key] = new { tmdbId, mediaType = type, percent, items };
                }
            }

            _cache = new List<object>(byMedia.Values);
            _cachedAt = DateTime.UtcNow;
            return Ok(_cache);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            return StatusCode(502, "Could not reach Seerr: " + ex.Message);
        }
        finally
        {
            Gate.Release();
        }
    }

    // ---------------------------------------------------------------------
    // GET /SeerrProgress/Requests : the logged-in user's own Seerr requests
    // ---------------------------------------------------------------------
    [HttpGet("Requests")]
    [Authorize]
    [Produces("application/json")]
    public async Task<ActionResult> GetRequests(CancellationToken ct)
    {
        var cfg = Plugin.Instance?.Configuration;
        if (cfg is null || string.IsNullOrWhiteSpace(cfg.SeerrUrl) || string.IsNullOrWhiteSpace(cfg.ApiKey))
        {
            return Ok(new { configured = false, linked = false, requests = new List<object>() });
        }

        // The Jellyfin user comes from the auth token, never from a query parameter,
        // so one user can't ask for another user's requests.
        var jfClaim = User.FindFirst("Jellyfin-UserId")?.Value;
        if (!Guid.TryParse(jfClaim, out var jfUser))
        {
            return Unauthorized();
        }

        try
        {
            var seerrUserId = await ResolveSeerrUser(jfUser, ct);
            if (seerrUserId is null)
            {
                return Ok(new { configured = true, linked = false, requests = new List<object>() });
            }

            if (RequestCache.TryGetValue(seerrUserId.Value, out var cached)
                && DateTime.UtcNow - cached.At < TimeSpan.FromSeconds(4))
            {
                return Ok(new { configured = true, linked = true, requests = cached.Data });
            }

            using var doc = await SeerrGet($"/request?take=50&skip=0&sort=added&filter=all&requestedBy={seerrUserId.Value}", ct);
            var rows = new List<Row>();

            if (doc is not null && doc.RootElement.TryGetProperty("results", out var results) && results.ValueKind == JsonValueKind.Array)
            {
                foreach (var r in results.EnumerateArray())
                {
                    if (!r.TryGetProperty("media", out var media) || media.ValueKind != JsonValueKind.Object) continue;
                    if (!media.TryGetProperty("tmdbId", out var tm) || tm.ValueKind != JsonValueKind.Number) continue;

                    var row = new Row
                    {
                        Id = r.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.Number ? idEl.GetInt32() : 0,
                        Type = media.TryGetProperty("mediaType", out var mt) && mt.ValueKind == JsonValueKind.String ? mt.GetString() ?? "" : "",
                        TmdbId = tm.GetInt32(),
                        ReqStatus = r.TryGetProperty("status", out var rst) && rst.ValueKind == JsonValueKind.Number ? rst.GetInt32() : 0,
                        MediaStatus = media.TryGetProperty("status", out var mst) && mst.ValueKind == JsonValueKind.Number ? mst.GetInt32() : 0,
                        CreatedAt = r.TryGetProperty("createdAt", out var ca) && ca.ValueKind == JsonValueKind.String ? ca.GetString() : null,
                        Is4k = r.TryGetProperty("is4k", out var k4) && k4.ValueKind == JsonValueKind.True
                    };

                    // seasons this request asked for
                    if (r.TryGetProperty("seasons", out var reqSeasons) && reqSeasons.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var rs in reqSeasons.EnumerateArray())
                        {
                            if (rs.TryGetProperty("seasonNumber", out var sn) && sn.ValueKind == JsonValueKind.Number)
                            {
                                row.Seasons.Add(sn.GetInt32());
                            }
                        }

                        row.Seasons.Sort();
                    }

                    // status of each season at media level, to tell "my season is available" from "some other season is"
                    var seasonStatus = new Dictionary<int, int>();
                    if (media.TryGetProperty("seasons", out var mediaSeasons) && mediaSeasons.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var ms in mediaSeasons.EnumerateArray())
                        {
                            if (ms.TryGetProperty("seasonNumber", out var msn) && msn.ValueKind == JsonValueKind.Number
                                && ms.TryGetProperty("status", out var mss) && mss.ValueKind == JsonValueKind.Number)
                            {
                                seasonStatus[msn.GetInt32()] = mss.GetInt32();
                            }
                        }
                    }

                    if (row.Type == "tv" && row.Seasons.Count > 0
                        && row.Seasons.All(n => seasonStatus.TryGetValue(n, out var v) && v == 5))
                    {
                        row.MediaStatus = 5;
                    }

                    // download progress
                    double size = 0, left = 0;
                    int count = 0;
                    if (media.TryGetProperty("downloadStatus", out var ds) && ds.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var d in ds.EnumerateArray())
                        {
                            count++;
                            if (d.TryGetProperty("size", out var sz) && sz.ValueKind == JsonValueKind.Number) size += sz.GetDouble();
                            if (d.TryGetProperty("sizeLeft", out var sl) && sl.ValueKind == JsonValueKind.Number) left += sl.GetDouble();
                            if (row.TimeLeft is null && d.TryGetProperty("timeLeft", out var tl) && tl.ValueKind == JsonValueKind.String)
                            {
                                row.TimeLeft = tl.GetString();
                            }
                        }
                    }

                    row.HasDownload = count > 0;
                    row.Percent = size > 0 ? Math.Round((1 - left / size) * 100, 1) : null;
                    rows.Add(row);
                }
            }

            // titles and posters, looked up once per media and cached
            var limiter = new SemaphoreSlim(5);
            var missing = rows
                .Select(x => (x.Type, x.TmdbId))
                .Distinct()
                .Where(x => !MediaInfo.ContainsKey($"{x.Type}:{x.TmdbId}"))
                .ToList();
            await Task.WhenAll(missing.Select(x => LoadInfo(x.Type, x.TmdbId, limiter, ct)));

            var output = new List<object>();
            foreach (var x in rows)
            {
                MediaInfo.TryGetValue($"{x.Type}:{x.TmdbId}", out var info);
                output.Add(new
                {
                    id = x.Id,
                    type = x.Type,
                    tmdbId = x.TmdbId,
                    title = info.Title ?? $"TMDB {x.TmdbId}",
                    year = info.Year,
                    poster = info.Poster,
                    state = StateOf(x.ReqStatus, x.MediaStatus, x.HasDownload),
                    percent = x.Percent,
                    timeLeft = x.TimeLeft,
                    seasons = x.Seasons,
                    is4k = x.Is4k,
                    requestedAt = x.CreatedAt
                });
            }

            RequestCache[seerrUserId.Value] = (DateTime.UtcNow, output);
            return Ok(new { configured = true, linked = true, requests = output });
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            return StatusCode(502, "Could not reach Seerr: " + ex.Message);
        }
    }

    // ---------------------------------------------------------------------
    // GET /SeerrProgress/client.js : the UI script (no secrets in it)
    // ---------------------------------------------------------------------
    [HttpGet("client.js")]
    [AllowAnonymous]
    public ActionResult GetClientScript()
    {
        var stream = typeof(Plugin).Assembly.GetManifestResourceStream($"{typeof(Plugin).Namespace}.Web.client.js");
        if (stream is null) return NotFound();
        return File(stream, "application/javascript");
    }

    // ---------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------
    private static string StateOf(int requestStatus, int mediaStatus, bool hasDownload)
    {
        if (requestStatus == 3) return "declined";
        if (requestStatus == 1) return "pending";
        if (requestStatus == 4) return "failed";
        if (requestStatus == 5 || mediaStatus == 5) return "available";
        if (hasDownload) return "downloading";
        if (mediaStatus == 4) return "partial";
        return "approved";
    }

    private async Task<JsonDocument?> SeerrGet(string path, CancellationToken ct)
    {
        var cfg = Plugin.Instance!.Configuration;
        using var req = new HttpRequestMessage(HttpMethod.Get, cfg.SeerrUrl.TrimEnd('/') + "/api/v1" + path);
        req.Headers.Add("X-Api-Key", cfg.ApiKey);

        using var client = _http.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(8);
        using var resp = await client.SendAsync(req, ct);
        if (resp.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            return null;
        }

        resp.EnsureSuccessStatusCode();
        return JsonDocument.Parse(await resp.Content.ReadAsStringAsync(ct));
    }

    private async Task<int?> ResolveSeerrUser(Guid jellyfinUser, CancellationToken ct)
    {
        var key = jellyfinUser.ToString("N");
        if (UserMap.TryGetValue(key, out var hit) && DateTime.UtcNow - hit.At < TimeSpan.FromMinutes(10))
        {
            return hit.SeerrId;
        }

        // direct lookup by Jellyfin user id (the id may be stored with or without dashes)
        foreach (var id in new[] { jellyfinUser.ToString("N"), jellyfinUser.ToString("D") })
        {
            using var doc = await SeerrGet("/user/jellyfin/" + id, ct);
            if (doc is not null && doc.RootElement.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.Number)
            {
                var seerrId = idEl.GetInt32();
                UserMap[key] = (seerrId, DateTime.UtcNow);
                return seerrId;
            }
        }

        // fallback: scan the user list
        using var users = await SeerrGet("/user?take=200", ct);
        if (users is not null && users.RootElement.TryGetProperty("results", out var list) && list.ValueKind == JsonValueKind.Array)
        {
            foreach (var u in list.EnumerateArray())
            {
                var jf = Str(u, "jellyfinUserId");
                if (jf is not null
                    && string.Equals(jf.Replace("-", string.Empty), key, StringComparison.OrdinalIgnoreCase)
                    && u.TryGetProperty("id", out var uid) && uid.ValueKind == JsonValueKind.Number)
                {
                    var seerrId = uid.GetInt32();
                    UserMap[key] = (seerrId, DateTime.UtcNow);
                    return seerrId;
                }
            }
        }

        return null;
    }

    private async Task LoadInfo(string type, int tmdbId, SemaphoreSlim limiter, CancellationToken ct)
    {
        await limiter.WaitAsync(ct);
        try
        {
            var path = (type == "movie" ? "/movie/" : "/tv/") + tmdbId;
            using var doc = await SeerrGet(path, ct);
            if (doc is null) return;

            var root = doc.RootElement;
            var title = Str(root, type == "movie" ? "title" : "name");
            var date = Str(root, type == "movie" ? "releaseDate" : "firstAirDate");
            var year = date is { Length: >= 4 } ? date[..4] : null;
            MediaInfo[$"{type}:{tmdbId}"] = (title, year, Str(root, "posterPath"));
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            // leave it uncached, the next refresh tries again
        }
        finally
        {
            limiter.Release();
        }
    }

    private static string? Str(JsonElement e, string name)
        => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
}
