// TeczoForge import settings (FRG-71).
// TeczoForge copies this file into every game export, in the Editor folder next to asset_manifest.json.
// Do not edit it inside a Unity project: the next export overwrites it.
//
// It sets the import settings by folder, but only inside a TeczoForge export:
// a folder named *_Assets that holds asset_manifest.json. Everything else in the project is left alone.
//
//   Sprites/, UI/, Icons/  -> Sprite (2D and UI)
//   Backgrounds/           -> Default, no mipmaps
//   Textures/              -> Default, with mipmaps
//   Audio/Music/           -> Streaming
//   Audio/SFX/             -> Decompress On Load

using System.IO;
using UnityEditor;
using UnityEngine;

public class TeczoForgeImporter : AssetPostprocessor
{
    // The path of this asset inside its TeczoForge export folder, for example "Sprites/Player/SKR_SPR_Player_Fox.png".
    // null if the asset is not inside a TeczoForge export.
    static string PathInsideExport(string assetPath)
    {
        // Unity asset paths use "/", for example "Assets/Art/SKR_Assets/Sprites/Player/SKR_SPR_Player_Fox.png".
        string[] parts = assetPath.Split('/');
        for (int i = parts.Length - 2; i >= 0; i--)
        {
            if (!parts[i].EndsWith("_Assets")) continue;
            string folder = string.Join("/", parts, 0, i + 1);
            // Unity runs with the project folder as the current folder, so this relative path works.
            if (!File.Exists(folder + "/asset_manifest.json")) continue;
            return string.Join("/", parts, i + 1, parts.Length - i - 1);
        }
        return null;
    }

    void OnPreprocessTexture()
    {
        string inside = PathInsideExport(assetPath);
        if (inside == null) return;
        TextureImporter importer = (TextureImporter)assetImporter;

        if (inside.StartsWith("Sprites/") || inside.StartsWith("UI/") || inside.StartsWith("Icons/"))
        {
            importer.textureType = TextureImporterType.Sprite;
            importer.spriteImportMode = SpriteImportMode.Single;
        }
        else if (inside.StartsWith("Backgrounds/"))
        {
            importer.textureType = TextureImporterType.Default;
            importer.mipmapEnabled = false;
        }
        else if (inside.StartsWith("Textures/"))
        {
            importer.textureType = TextureImporterType.Default;
            importer.mipmapEnabled = true;
        }
    }

    void OnPreprocessAudio()
    {
        string inside = PathInsideExport(assetPath);
        if (inside == null) return;
        AudioImporter importer = (AudioImporter)assetImporter;

        AudioImporterSampleSettings settings = importer.defaultSampleSettings;
        if (inside.StartsWith("Audio/Music/"))
        {
            settings.loadType = AudioClipLoadType.Streaming;
        }
        else if (inside.StartsWith("Audio/SFX/"))
        {
            settings.loadType = AudioClipLoadType.DecompressOnLoad;
        }
        else
        {
            return;
        }
        importer.defaultSampleSettings = settings;
    }
}
