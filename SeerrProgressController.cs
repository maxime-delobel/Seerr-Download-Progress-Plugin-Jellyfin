using System;
using System.Collections.Generic;
using System.IO;
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
    private static readonly SemaphoreSlim Gate = new(1, 1);
    private static DateTime _cachedAt = DateTime.MinValue;
    private static List<object> _cache = new();

    private readonly IHttpClientFactory _http;

    private sealed class Agg
    {
        public double Size;
        public double Left;
        public int Count;
        public string? TimeLeft;
        public string? Status;
    }

    public SeerrProgressController(IHttpClientFactory http)
    {
        _http = http;
    }

    // Any logged-in Jellyfin user can read progress. The Seerr key never leaves the server.
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

            var url = cfg.SeerrUrl.TrimEnd('/') + "/api/v1/request?take=100&filter=processing";
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.Add("X-Api-Key", cfg.ApiKey);

            using var client = _http.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(8);
            using var resp = await client.SendAsync(req, ct);
            if (!resp.IsSuccessStatusCode)
            {
                return StatusCode(502, $"Seerr returned {(int)resp.StatusCode}");
            }

            using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(ct));
            var byMedia = new Dictionary<string, object>();

            if (doc.RootElement.TryGetProperty("results", out var results))
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

    // Loaded by the web UI with a plain import(), so it can't carry auth. It contains no secrets.
    [HttpGet("client.js")]
    [AllowAnonymous]
    public ActionResult GetClientScript()
    {
        var stream = typeof(Plugin).Assembly.GetManifestResourceStream($"{typeof(Plugin).Namespace}.Web.client.js");
        if (stream is null) return NotFound();
        return File(stream, "application/javascript");
    }
}
