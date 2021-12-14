import * as minimist from 'minimist';

export class ArgumentParser {
  public static get<T>(optionName: string): T {
    const argv = minimist(process.argv.slice(2));
    return argv[optionName] || process.env[`npm_config_${optionName}`] || null;
  }
}
