import { stringify } from 'csv-stringify/sync';
import { promises as fs } from 'fs';
import { FileHandle } from 'fs/promises';

export class CsvFileWriter {
  private fileHandle: FileHandle;
  private filePath;
  private headerSize: number;
  public constructor(filePath: string) {
    this.filePath = filePath;
  }

  get isInitialized(): boolean {
    return !!this.fileHandle;
  }

  public async writeHeaders(headers: string[]) {
    this.headerSize = headers.length;
    this.fileHandle = await fs.open(this.filePath, 'w');
    await this.writeLine(headers);
  }

  public async writeLine(lines: string[]) {
    if (lines.length != this.headerSize) {
      throw new Error('csv fields count does not match');
    }
    const csvLine = stringify([lines]);
    await fs.writeFile(this.fileHandle, csvLine);
    await this.fileHandle.datasync();
  }
}
