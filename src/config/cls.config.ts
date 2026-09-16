export interface AppConfiguration {
  importOptions: {
    captureUnitSize: number;
    captureUnitUnit: string;
    forceMaxSceneSize: boolean;
    maxSceneSize: number;
    forceInitialScaleLimit: boolean;
    initialScaleLimit: number;
  };

  objectFiltering: {
    hideLargestObjectsPercent: number;
  };

  canRecalculateDistortion: boolean;
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
    },

    objectFiltering: {
      hideLargestObjectsPercent: 10,
    },

    canRecalculateDistortion: true,
  };

  static conf: Config;

  config: AppConfiguration;

  constructor(savedConfig?: AppConfiguration) {
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
    if (!Config.conf) {
      const savedConfigJson = localStorage.getItem('app-config');
      let savedConfig;
      if (savedConfigJson) {
        savedConfig = JSON.parse(savedConfigJson);
      }

      Config.conf = new Config(savedConfig);
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
    const savedConfigJson = localStorage.getItem('app-config');
    let savedConfig;
    if (savedConfigJson) {
      savedConfig = JSON.parse(savedConfigJson);
    }

    if (Config.validateConfig(savedConfig)) {
      Config.conf.config = new Config(savedConfig).config;
    } else {
      Config.conf.config = new Config().config;
    }
  }
  /**
   * Same as above, but in instance method shape
   */
  loadConfig() {
    Config.loadConfig();
  }

  /**
   * Resets configuration to default values.
   */
  static resetConfig() {
    Config.conf.config = new Config().config;
  }
  /**
   * Resets configuration to default (instance edition)
   */
  resetConfig() {
    this.config = JSON.parse(JSON.stringify(Config.defaultConfig));
  }

  /**
   * Saves the current configuration to localStorage.
   */
  static saveConfig() {
    if (Config.conf && Config.conf.config) {
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
