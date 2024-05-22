import { mainLog } from './utils/logger.js';
import { promises as fs } from 'fs';
import sanitize from 'sanitize-filename';
import { existsSync } from 'fs';
import { ArgumentParser } from './utils/argumentparser.js';
import { ApiClient } from './utils/apiclient.js';
import { getFilePath, writeRevisionExport, CsvType } from './utils/csvFile.js';
import { DocumentNode, ElementType, ExportOptions, ListResponse, Revision, RevisionExport } from './utils/onshapetypes.js';
import { TranslationHelper } from './utils/translationhelper.js';

const LOG = mainLog();

/** EXPORT_OPTIONS  These are the default options for exports for various formats
 * You can optionally edit this section to override options used to export various formats
*/
const EXPORT_OPTIONS : Record<string, ExportOptions> = {
  'pdf': {
    formatName: 'PDF',
    colorMethod: 'color', // Only supported for drawings and can be blackandwhite or grayscale
    showOverriddenDimensions: true,
  },
  'dwg': {
    formatName: 'DWG',
  },
  'dxf': {
    formatName: 'DXF',
  },
  'json': {
    formatName: 'DRAWING_JSON',
    level: 'full'
  },
  'step': {
    formatName: 'STEP',
  },
  'acis': {
    formatName: 'ACIS',
  },
};

class RevisionProcessor {
  private processRevs: Record<string, string> = {};
  private lastCreatedAt: Date = null;
  private exportTypes: Record<number, string> = {};
  private translationHelper: TranslationHelper = null;
  private useExportRules: boolean = true;


  public constructor(private apiClient: ApiClient, private companyId: string, private findAll: boolean) {
    const partExportType: string = ArgumentParser.getLowerCase('part');
    if (partExportType) {
      this.exportTypes[ElementType.PARTSTUDIO] = partExportType;
    }
    const drawingExportType: string = ArgumentParser.getLowerCase('drawing');
    if (drawingExportType) {
      this.exportTypes[ElementType.DRAWING] = drawingExportType;
    } else if (!partExportType) {
      this.exportTypes[ElementType.DRAWING] = 'pdf';
    }
    this.translationHelper = new TranslationHelper(apiClient);
    this.useExportRules = !! ArgumentParser.get('export-rules', true);
    LOG.info('Specified types=%s useExportRules=%s', this.exportTypes, this.useExportRules);
  }

  public async processSingleRev(rev: Revision) : Promise<ExportOptions> {
    LOG.debug(`Processing revision partnum=${rev.partNumber} revision=${rev.revision} elementType=${rev.elementType}`);
    const exportFormatName = this.exportTypes[rev.elementType];
    if (!exportFormatName) {
      LOG.debug(`elementype=${rev.elementType} partNumer=${rev.partNumber} revision=${rev.revision} has no export specified`);
      return null;
    }
    await this.validDocument(rev);
    const exportOptions = await this.getExportFileName(rev, exportFormatName);

    if (rev.elementType == ElementType.DRAWING) {
      await this.translationHelper.exportDrawingRevisionSync(rev, exportOptions);
    } else if (rev.elementType == ElementType.PARTSTUDIO) {
      await this.translationHelper.exportPartRevisionSync(rev, exportOptions);
    }
    return exportOptions;
  }

  private async getExportFileName(rev: Revision, exportFormatName : string) : Promise<ExportOptions> {
    const exportOptions = Object.assign({}, EXPORT_OPTIONS[exportFormatName]);
    exportOptions.destinationName = sanitize( `${rev.partNumber}_${rev.revision}` );
    exportOptions.fileExtension = exportFormatName;
    if (!this.useExportRules) {
      return exportOptions;
    }

    let baseUrl = `api/exportrules/d/${rev.documentId}/v/${rev.versionId}/e/${rev.elementId}`;
    if (rev.partId) {
      baseUrl += '/p/' + encodeURIComponent(rev.partId);
    }

    baseUrl += `?elementType=${rev.elementType}`;

    if (rev.configuration) {
      baseUrl += '?configuration=' + encodeURIComponent(rev.configuration);
    }

    const exportRule = await this.apiClient.post(baseUrl, {
      fileType: exportOptions?.formatName || null
    }) as Record<string, string>;

    if (exportRule.exportFileName) {
      exportOptions.destinationName = sanitize( exportRule.exportFileName );
    }
    return exportOptions;
  }

  private async validDocument(rev: Revision) {
    const docResponse = await this.apiClient.get(`api/documents/${rev.documentId}`) as DocumentNode;
    if (!docResponse || docResponse.trash) {
      throw new Error(`Failed to find documentId=${rev.documentId}`);
    }

    if (docResponse.owner?.id != this.companyId) {
      throw new Error(`DocumentId=${rev.documentId} is not owned by company`);
    }
  }

  /**
   * Process all revisions and trigger export as needed
   */
  public async enumerateAllRevisions() {
    const latestOnlyValue = this.findAll ? 'false' : 'true';
    let nextBatchUri = `api/revisions/companies/${this.companyId}?latestOnly=${latestOnlyValue}`;
    if (this.lastCreatedAt) {
      nextBatchUri = `${nextBatchUri}&after=${this.lastCreatedAt.toISOString()}&offset=1`;
    }
    LOG.info('Staring revision search from date =', this.lastCreatedAt);
    let totalRevCount = 0;
    while (nextBatchUri) {
      LOG.info(`Calling ${nextBatchUri}`);
      const revsResponse = await this.apiClient.get(nextBatchUri) as ListResponse<Revision>;
      if (revsResponse.items) {
        totalRevCount += revsResponse.items.length;
        LOG.info(`Found total revisions = ${totalRevCount}`);
        for (const rev of revsResponse.items) {
          const exportResult: RevisionExport = {
            id: rev.id,
            companyId: rev.companyId,
            createdAt: rev.createdAt,
            partNumber: rev.partNumber,
            revision: rev.revision,
            elementType: rev.elementType
          };
          try {
            const exportOptions = await this.processSingleRev(rev);
            if (exportOptions) {
              exportResult.fileName = `${exportOptions.destinationName}.${exportOptions.fileExtension}`;
            }
          } catch (error) {
            exportResult.message = String(error);
            LOG.info(`Failed to export revision=${rev.id} partNumer=${rev.partNumber} revision=${rev.revision}`, error);
          } finally {
            exportResult.exportedAt = new Date().toISOString();
            await writeRevisionExport(exportResult);
          }
        }
      }
      nextBatchUri = revsResponse.next;
    }
  }

  /**
   * Figure out last revision that was exported. Either from
   * csv file or from --days option
   */
  public async loadProcessedRevisions() {
    const csvFilePath = getFilePath(CsvType.REVISION_EXPORT);
    let lastCreatedAt = null;
    if (existsSync(csvFilePath)) {
      const fileBuffer = await fs.readFile(csvFilePath);
      const allLines = fileBuffer.toString().split('\n');
      for (const aLine of allLines) {
        if (aLine.includes(this.companyId)) {
          const [revId, createdAt] = aLine.split(',');
          if (revId && revId.match(/[0-9A-Fa-f]{10,}/)) {
            this.processRevs[revId] = createdAt;
            lastCreatedAt = createdAt;
          }
        }
      }
    }

    if (lastCreatedAt) {
      this.lastCreatedAt = new Date(lastCreatedAt);
    } else {
      const nDays = Number(ArgumentParser.get('days', 30));
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - nDays);
      this.lastCreatedAt = new Date(startDate);
    }
  }
}


try {
  const stackToUse: string = ArgumentParser.get('stack');
  const findAll: boolean = ArgumentParser.get('all');
  const apiClient = await ApiClient.createApiClient(stackToUse);
  const companyInfo = await apiClient.findCompanyInfo();
  if (!companyInfo.admin) {
    throw new Error('Company admin permission required for exporting revisions');
  }
  const revProcessor = new RevisionProcessor(apiClient, companyInfo.id, findAll);
  await revProcessor.loadProcessedRevisions();
  await revProcessor.enumerateAllRevisions();
} catch (error) {
  console.error(error);
  LOG.error('Exporting all revisions failed', error);
}
