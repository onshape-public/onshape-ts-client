import sanitize from 'sanitize-filename';
import timeSpan from 'time-span';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { ApiClient } from './apiclient.js';
import { FolderType, getFolderPath } from './fileutils.js';
import { mainLog } from './logger.js';
import { BasicNode, ExportOptions, Revision } from './onshapetypes.js';
const LOG = mainLog();

/**
 * The typical response of translation POST request
 */
interface TranslationJob extends BasicNode {
  /** Current completion status of translation job */
  requestState: 'ACTIVE' | 'DONE' | 'FAILED';
  /** The document that contains the element or part to be translated */
  documentId?: string;
  /** The element that contains part or itself to be translated */
  requestElementId?: string;
  /** The foreign data like PDF/step that can be downloaded once translation is finished */
  resultExternalDataIds?: string[];
  /** Reason why the translation failed if not DONE */
  failureReason?: string;
}

/**
 * Illustrates invoking a translation and downloading the result
 */
export class TranslationHelper {
  readonly apiClient: ApiClient = null;
  readonly translationIdToFilePath = new Map<string, string>();

  public constructor(apiClient: ApiClient) {
    this.apiClient = apiClient;
  }

  /** Invoke a Drawing PDF translation and wait for webhook event onshape.model.translation.complete to download it  */
  public async exportDrawingRevision(rev: Revision) {
    const documentId = rev.documentId;
    const filenameNoExt = sanitize(`${rev.partNumber}_${rev.revision}`);
    const outputFileName = `${filenameNoExt}.pdf`;
    const pdfOutput = getFolderPath(FolderType.EXPORTS) + '/' + outputFileName;

    // Initiate drawing to PDF translation
    const translationReq = await this.apiClient.post(`api/drawings/d/${documentId}/v/${rev.versionId}/e/${rev.elementId}/translations`, {
      formatName: 'PDF',
      storeInDocument: false,
      showOverriddenDimensions: true,
      destinationName: outputFileName
    }) as BasicNode;

    this.translationIdToFilePath.set(translationReq.id, pdfOutput);
    LOG.debug('Initiated Drawing translationReq', translationReq);
  }

  /** Invoke a GTLF translation, Unlike other exports this returns the response instead of creating a translation job */
  public async exportAssemblyRevision(rev: Revision) {
    const documentId = rev.documentId;
    const filenameNoExt = sanitize(`${rev.partNumber}_${rev.revision}`);
    const outputFileName = `${filenameNoExt}.gltf`;
    const gltOutput = getFolderPath(FolderType.EXPORTS) + '/' + outputFileName;

    // gtlf is requested with a Accept Header of either model/gltf-binary or model/gltf+json
    const acceptHeader = 'model/gltf+json';
    const gltfResponse = await this.apiClient.get(`api/assemblies/d/${documentId}/v/${rev.versionId}/e/${rev.elementId}/gltf`, acceptHeader);
    await fs.writeFile(gltOutput, JSON.stringify(gltfResponse, null, 2));
  }

  /** Invoke a Drawing translation and poll its status periodically until DONE to download it */
  public async exportDrawingRevisionSync(rev: Revision, exportOptions: ExportOptions) {
    const documentId = rev.documentId;
    const outputFileName = `${exportOptions.destinationName}.${exportOptions.fileExtension}`;
    const fullOutputPath = getFolderPath(FolderType.EXPORTS) + '/' + outputFileName;
    exportOptions.storeInDocument = false;

    if (await this.isRevAlreadyExported(rev, fullOutputPath)) {
      return;
    }

    // Initiate drawing to PDF translation
    const jobStatus = await this.apiClient.post(`api/drawings/d/${documentId}/v/${rev.versionId}/e/${rev.elementId}/translations`, exportOptions) as TranslationJob;
    LOG.info(`Initiated Drawing ${rev.partNumber} translation for format ${exportOptions.formatName}`, jobStatus);
    await this.pollUntilCompletion(rev, jobStatus);
    await this.downloadCompletedFile(jobStatus, fullOutputPath);
  }

  private async isRevAlreadyExported(rev: Revision, existingFilePath: string) {
    if (existsSync(existingFilePath)) {
      const fStats = await fs.stat(existingFilePath);
      const revCreationDate = new Date(rev.createdAt);
      const fileCreationDate = new Date(fStats.ctime);
      LOG.info(`Skipping ${rev.partNumber}_${rev.revision} as it is already exported`);
      return fileCreationDate > revCreationDate;
    }
    return false;
  }

  /** Invoke a Part translation and poll its status periodically until DONE to download it */
  public async exportPartRevisionSync(rev: Revision, exportOptions: ExportOptions) {
    const documentId = rev.documentId;
    const outputFileName = `${exportOptions.destinationName}.${exportOptions.fileExtension}`;
    const fullOutputPath = getFolderPath(FolderType.EXPORTS) + '/' + outputFileName;

    if (await this.isRevAlreadyExported(rev, fullOutputPath)) {
      return;
    }

    exportOptions.storeInDocument = false;
    exportOptions.partIds =rev.partId;

    // Initiate a request to translate part. This gives href that you can poll to see if the translation has completed
    const jobStatus = await this.apiClient.post(`api/partstudios/d/${documentId}/v/${rev.versionId}/e/${rev.elementId}/translations`, exportOptions) as TranslationJob;

    LOG.info(`Initiated Part ${rev.partNumber} translation for format ${exportOptions.formatName}`, jobStatus);
    await this.pollUntilCompletion(rev, jobStatus);
    await this.downloadCompletedFile(jobStatus, fullOutputPath);
  }

  private async pollUntilCompletion(rev: Revision, jobStatus: TranslationJob) {
    // Poll repeatedly until the export has finished
    const end = timeSpan();
    while (jobStatus.requestState === 'ACTIVE') {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const elaspedSeconds = end.seconds();

      // If export takes over 10 minutes error and continue
      if (elaspedSeconds > 600) {
        throw new Error(`Translation timed out after ${elaspedSeconds} seconds`);
      }

      LOG.debug(`Waited for translation ${rev.partNumber} seconds=${elaspedSeconds}`);
      const latestStatus = await this.apiClient.get(jobStatus.href) as TranslationJob;
      Object.assign(jobStatus, latestStatus);
    }
  }

  /** Called to webhook notification when translation is done or failed */
  public async downloadTranslation(translationId: string) {
    const filePath = this.translationIdToFilePath.get(translationId);
    // No record of this translation so most likely not initiated by this application
    if (!filePath) {
      return;
    }

    const completedTranslation = await this.apiClient.get(`api/translations/${translationId}`) as TranslationJob;
    await this.downloadCompletedFile(completedTranslation, filePath);
  }

  private async downloadCompletedFile(completedTranslation: TranslationJob, filePath: string) {
    LOG.debug('Completed Translation status', completedTranslation);
    const externalId = completedTranslation.resultExternalDataIds?.[0];
    const documentId = completedTranslation.documentId;
    if (documentId && externalId && completedTranslation.requestState === 'DONE') {
      await this.apiClient.downloadFile(`api/documents/d/${documentId}/externaldata/${externalId}`, filePath);
    } else {
      LOG.error('Bad translation completion status', completedTranslation);
      throw new Error(`Translation completion ${completedTranslation}`);
    }
  }
}
