using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.SeerrProgress;

public class PluginConfiguration : BasePluginConfiguration
{
    public string SeerrUrl { get; set; } = "http://localhost:5055";
    public string ApiKey { get; set; } = string.Empty;
}
