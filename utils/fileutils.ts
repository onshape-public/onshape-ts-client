import Path from 'path';
import { mkdirp } from 'mkdirp';
import { existsSync } from 'fs';
import { ArgumentParser } from './argumentparser.js';


export enum FolderType {
  OUTPUT, REPORTS, EXPORTS
}

/**
 * For input script webhook.ts, the log name is webhook
 */
export function getLogName() {
  const logFileName = Path.parse(process.argv[1] || 'main').name;
  return logFileName;
}

/**
 * For input script webhook.ts, the log filename is ./logs/webhook.log
 */
export function getLogFilePath() {
  const logFolder = './logs';
  mkdirp.sync(logFolder);
  return Path.join(logFolder, `${getLogName()}.log`);
}

const FOLDERS: Record<string, string> = {};

function ensureFolderExists(folder: string) {
  mkdirp.sync(folder);

  if (!existsSync(folder)) {
    throw new Error(`Failed to create folder ${folder}`);
  }
}

/**
 * For input script webhook.ts
 *    csvs go into ./reports/webhook/
 *    step/pdf go into ./exports/webhook/
 *    json object dumps go into ./output/webhook/
 */
export function getFolderPath(type: FolderType) {
  let folder = FOLDERS[type];
  if (folder) {
    return folder;
  }

  switch (type) {
  case FolderType.OUTPUT:
    folder = './output';
    break;
  case FolderType.REPORTS:
    folder = './reports';
    break;
  case FolderType.EXPORTS:
    folder = './exports';
    break;
  default:
    throw new Error(`Unhandled FolderType=${type}`);
  }

  folder = Path.resolve(folder, getLogName());
  ensureFolderExists(folder);
  FOLDERS[type] = folder;
  return folder;
}

function initFolderOverrides() {
  const argOptions: Record<FolderType, string> = {
    [FolderType.OUTPUT]: 'output-dir',
    [FolderType.REPORTS]: 'report-dir',
    [FolderType.EXPORTS]: 'export-dir'
  };
  for (const [fType, argOption] of Object.entries(argOptions)) {
    const folder = ArgumentParser.get(argOption) as string;
    if (folder) {
      ensureFolderExists(folder);
      FOLDERS[fType] = folder;
    }
  }
}

initFolderOverrides();
