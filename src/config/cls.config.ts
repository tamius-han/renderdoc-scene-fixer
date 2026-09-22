import { AxisDirection } from '../types/axis-direction.type';

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
    exportTextures: boolean;
    splitLooseParts: boolean;
    fillHoles: boolean;
    resizeExportedObject: boolean;
    approximateHeight: number;

    exportType: 'output' | 'input';
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
    activeTool: 'select-by-volume' | 'select-landmark' | 'select-ground-plane' | 'select-up-axis' | 'axis-mapper' | 'lasso-select' | null;

    selectAreaTool: "sphere" | "box";
    selectAreaMode: "inside" | "outside";
  };

  resourcesPanel: {
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
        up: '+y',
        forward: '+z',
        right: '+x',
      },
    },
    exportOptions: {
      exportTextures: true,
      splitLooseParts: true,
      fillHoles: true,
      resizeExportedObject: true,
      approximateHeight: 100,
      exportType: 'output',
    },

    objectFiltering: {
      hideLargestObjectsPercent: 10,
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
      selectAreaTool: 'sphere',
      selectAreaMode: "inside",
    },

    resourcesPanel: {
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
      Config.conf.config = new Config(savedConfig).config;
    } else {
      console.warn('[config] Configuration validation failed — returning default configuration');
      Config.conf.config = new Config().config;
    }
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
