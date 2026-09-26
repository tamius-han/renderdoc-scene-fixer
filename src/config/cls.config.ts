import { AxisDirection } from '../types/axis-direction.type';

/** One category of texture (base color, normal map, or combined
 * metalness/roughness) an export can include or exclude - see the
 * "Textures" fields in the export dialog (cmp.export-mesh.ts) and
 * SceneViewerApp.shouldExportTexture()/buildExportEntriesForDraw(). */
export interface ExportTextureCategoryOptions {
  /** The category's own checkbox - when off, NO texture of this kind is
   * ever embedded, regardless of excludedPaths below. */
  enabled: boolean;
  /** Resolved virtual-filesystem paths of individual textures the user has
   * unchecked in this category's picker popup, so a specific texture can
   * be left out even while the category as a whole stays enabled -
   * needed because this app's bind-point-based heuristic for "which
   * texture is the normal map/metalness-roughness map" (see
   * SceneViewerApp.describeTextureType()) is just that, a heuristic, and
   * can guess wrong for a given capture. Paths that no longer appear in
   * the current selection are simply never matched against - harmless to
   * leave in place rather than pruning. */
  excludedPaths: string[];
}

export interface AppConfiguration {
  importOptions: {
    captureUnitSize: number;
    captureUnitUnit: string;
    forceMaxSceneSize: boolean;
    maxSceneSize: number;
    forceInitialScaleLimit: boolean;
    initialScaleLimit: number;

    inputGeometryOrientation: {
      up: AxisDirection;
      forward: AxisDirection;
      right: AxisDirection;
    };
  };
  exportOptions: {
    splitLooseParts: boolean;
    fillHoles: boolean;
    resizeExportedObject: boolean;
    approximateHeight: number;
    moveToOrigin: boolean;

    exportType: 'output' | 'input';

    /** When on, exported materials skip the KHR_materials_unlit extension,
     * so any embedded normal/metallic-roughness maps (see
     * SceneViewerApp.loadAuxiliaryDrawTextures()) actually drive lit PBR
     * shading in Blender (or any other conformant glTF viewer) instead of
     * being ignored in favor of this app's own flat, unshaded look. Off by
     * default - see cmp.export-mesh.ts. */
    litShading: boolean;

    baseColorTextures: ExportTextureCategoryOptions;
    normalTextures: ExportTextureCategoryOptions;
    metallicRoughnessTextures: ExportTextureCategoryOptions;

    /** pbrMetallicRoughness.metallicFactor/roughnessFactor to use for a
     * draw whose material ends up with NO metalness/roughness texture
     * embedded (see the "Metallic/roughness textures" checkbox and picker
     * above) - i.e. the constant fallback, not a multiplier against a
     * texture (when a texture IS embedded, the factor is left at 1 so the
     * texture alone drives the channel - see getOrCreateMaterial() in
     * gltf-exporter.ts). Sliders in the export dialog; defaults match
     * glTF's own spec defaults for "no info available" (fully
     * non-metallic, fully rough). */
    metallicFactor: number;
    roughnessFactor: number;
  };

  objectFiltering: {
    hideLargestObjectsPercent: number;
  };

  controls: {
    controlScheme: 'asdf' | 'esdf';
  };

  canRecalculateDistortion: boolean;
}

export interface AppSessionConfiguration {
  tools: {
    activeTool: 'select-by-volume' | 'select-landmark' | 'select-ground-plane' | 'select-up-axis' | 'axis-mapper' | null;

    selectAreaTool: "sphere" | "box";
    selectAreaMode: "inside" | "outside";
  };

  resourcesPanel: {
    visible: boolean;
  };

  boundingBox: {
    visible: boolean;
  };
}

export class Config {

  private static defaultConfig: AppConfiguration = {
    importOptions: {
      captureUnitSize: 1,
      captureUnitUnit: 'm',
      forceMaxSceneSize: false,
      maxSceneSize: 10000,
      forceInitialScaleLimit: true, // viewport is this many units across
      initialScaleLimit: 100,

      inputGeometryOrientation: {
        up: '-z',
        forward: '+y',
        right: '-x',
      },
    },
    exportOptions: {
      splitLooseParts: true,
      fillHoles: true,
      resizeExportedObject: true,
      approximateHeight: 100,
      moveToOrigin: true,
      exportType: 'output',
      litShading: false,

      baseColorTextures: { enabled: true, excludedPaths: [] },
      normalTextures: { enabled: true, excludedPaths: [] },
      metallicRoughnessTextures: { enabled: true, excludedPaths: [] },

      metallicFactor: 0,
      roughnessFactor: 1,
    },

    objectFiltering: {
      hideLargestObjectsPercent: 5,
    },
    controls: {
      controlScheme: 'esdf',
    },

    canRecalculateDistortion: true,
  };

  static conf: Config;

  config: AppConfiguration;
  static sessionConfig: AppSessionConfiguration = {
    tools: {
      activeTool: null,

      selectAreaTool: 'sphere',
      selectAreaMode: "inside",
    },

    resourcesPanel: {
      visible: false
    },

    boundingBox: {
      visible: false
    }
  }

  constructor(savedConfig?: AppConfiguration) {
    console.info('initializing app config. Provided AppConfiguration?', savedConfig);

    if (savedConfig) {
      this.config = savedConfig;
    } else {
      this.config = JSON.parse(JSON.stringify(Config.defaultConfig));
    }
  }

  /**
   * Gets Config instance
   * @returns
   */
  static getConfig(): Config {
    console.info('[config] getting conf ...');

    if (!Config.conf) {
      Config.conf = new Config();
      Config.loadConfig();
    }

    return Config.conf;
  }

  /**
   * Validates configuration object
   * @param config
   * @returns
   */
  static validateConfig(config: AppConfiguration): boolean {
    if (!config) return false;
    if (!config.importOptions) return false;
    if (typeof config.importOptions.captureUnitSize !== 'number') return false;
    if (typeof config.importOptions.captureUnitUnit !== 'string') return false;
    if (typeof config.importOptions.forceMaxSceneSize !== 'boolean') return false;
    if (typeof config.importOptions.maxSceneSize !== 'number') return false;
    if (typeof config.importOptions.forceInitialScaleLimit !== 'boolean') return false;
    if (typeof config.importOptions.initialScaleLimit !== 'number') return false;
    if (!config.importOptions.inputGeometryOrientation) return false;
    if (typeof config.importOptions.inputGeometryOrientation.up !== 'string') return false;
    if (typeof config.importOptions.inputGeometryOrientation.forward !== 'string') return false;
    if (typeof config.importOptions.inputGeometryOrientation.right !== 'string') return false;
    if (!config.objectFiltering) return false;
    if (typeof config.objectFiltering.hideLargestObjectsPercent !== 'number') return false;
    if (typeof config.canRecalculateDistortion !== 'boolean') return false;
    return true;
  }

  /**
   * Loads configuration from localStorage. If localStorage configuration
   * does not exist or is invalid, default configuration will be used.
   */
  static loadConfig() {
    console.info('[config] loading config from localStorage ...');

    const savedConfigJson = localStorage.getItem('app-config');
    let savedConfig;
    if (savedConfigJson) {
      savedConfig = JSON.parse(savedConfigJson);
    }

    console.info('[config] saved config:', savedConfig);

    if (Config.validateConfig(savedConfig)) {
      console.info('[config] Configuration validated successfully');
      Config.conf.config = new Config(Config.mergeWithDefaults(savedConfig)).config;
    } else {
      console.warn('[config] Configuration validation failed — returning default configuration');
      Config.conf.config = new Config().config;
    }
  }

  /** Fills in any config field missing from a saved blob with its default
   * value, rather than trusting the saved blob's shape outright.
   * validateConfig() above only checks a handful of TOP-LEVEL fields, not
   * every nested one, so an older saved blob predating some later-added
   * nested field (e.g. exportOptions.baseColorTextures/normalTextures/
   * metallicRoughnessTextures, added alongside the export dialog's
   * texture-category pickers) would otherwise leave that field simply
   * undefined once loaded - which validateConfig() wouldn't catch, but
   * which breaks anything that reads it (e.g.
   * `exportOptions.baseColorTextures.enabled` throwing outright, since
   * there's no object there to read `.enabled` off of). Merging onto a
   * fresh copy of defaultConfig, field by field for every nested object,
   * means new fields silently pick up their default instead. */
  private static mergeWithDefaults(saved: AppConfiguration): AppConfiguration {
    const defaults: AppConfiguration = JSON.parse(JSON.stringify(Config.defaultConfig));
    return {
      ...defaults,
      ...saved,
      importOptions: {
        ...defaults.importOptions,
        ...saved.importOptions,
        inputGeometryOrientation: {
          ...defaults.importOptions.inputGeometryOrientation,
          ...saved.importOptions?.inputGeometryOrientation,
        },
      },
      exportOptions: {
        ...defaults.exportOptions,
        ...saved.exportOptions,
        baseColorTextures: { ...defaults.exportOptions.baseColorTextures, ...saved.exportOptions?.baseColorTextures },
        normalTextures: { ...defaults.exportOptions.normalTextures, ...saved.exportOptions?.normalTextures },
        metallicRoughnessTextures: {
          ...defaults.exportOptions.metallicRoughnessTextures,
          ...saved.exportOptions?.metallicRoughnessTextures,
        },
      },
      objectFiltering: { ...defaults.objectFiltering, ...saved.objectFiltering },
      controls: { ...defaults.controls, ...saved.controls },
    };
  }
  /**
   * Same as above, but in instance method shape
   */
  loadConfig() {
    Config.loadConfig();

    return this.config;
  }

  /**
   * Resets configuration to default values.
   */
  static resetConfig() {
    console.warn('App configuration will be reset');
    Config.conf.config = new Config().config;
  }
  /**
   * Resets configuration to default (instance edition)
   */
  resetConfig() {
    Config.resetConfig();
  }

  /**
   * Saves the current configuration to localStorage.
   */
  static saveConfig() {
    if (Config.conf && Config.conf.config) {
      console.info('saving configuration to localStorage');
      localStorage.setItem('app-config', JSON.stringify(Config.conf.config));
    }
  }
  /**
   * Saves the current configuration to localStorage (but instance method).
   */
  saveConfig() {
    Config.saveConfig();
  }

}
