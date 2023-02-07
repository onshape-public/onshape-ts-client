import { promises as fs } from 'fs';
import { constants } from 'fs';
import { mainLog } from './utils/logger.js';
import { FolderType, getFolderPath } from './utils/fileutils.js';
import { ArgumentParser } from './utils/argumentparser.js';
import { ApiClient } from './utils/apiclient.js';
import { writeDocumentReferences } from './utils/csvFile.js';
import {
  BasicNode,
  DocumentNode,
  DOCUMENT_SUMMARY,
  FOLDER,
  GlobalNodeList,
  WorkspaceRef
} from './utils/onshapetypes.js';

const LOG = mainLog();
const OUTPUT_FOLDER = getFolderPath(FolderType.OUTPUT);

class SummaryReport {
  private allDocIds = new Set<string>();
  private docToExtRef = new Map<string, Set<string>>();
  private processedDocs = new Map<string, DocumentNode>();
  private processedFolders = new Map<string, BasicNode>();
  private docToParent = new Map<string, BasicNode>();
  private folderDocs = new Map<string, DocumentNode>();

  public async printReport() {
    LOG.info('Processed folder count=', this.processedFolders.size);
    LOG.info('Processed document in folder count=', this.folderDocs.size);
    LOG.info('Processed Full document count=', this.processedDocs.size);
    LOG.info('Encountered document count=', this.allDocIds.size);
  }

  public constructor(private apiClient: ApiClient) { }

  private async getExternalReferences(doc: DocumentNode): Promise<Set<string>> {
    const documentExtRefs = new Set<string>();
    const workspacesReq = `api/documents/d/${doc.id}/workspaces`;
    const workspaceList = await this.apiClient.get(workspacesReq) as BasicNode[];
    for (const workspace of workspaceList) {
      const fileName = `${OUTPUT_FOLDER}/document_${doc.id}_workspace_${workspace.id}.json`;
      LOG.info(`    Processing workspace=${workspace.id} name=${workspace.name}`);
      let workspaceRef: WorkspaceRef = null;

      try {
        await fs.access(fileName, constants.R_OK);
        workspaceRef = JSON.parse(await fs.readFile(fileName, 'utf8'));
      } catch {
        workspaceRef = await this.apiClient.get(`api/documents/d/${doc.id}/w/${workspace.id}/externalreferences`) as WorkspaceRef;
        await fs.writeFile(fileName, JSON.stringify(workspaceRef, null, 2));
      }

      if (workspaceRef.documents) {
        for (const doc of workspaceRef.documents) {
          documentExtRefs.add(doc.id);
        }
      }

      [Object.values(workspaceRef.elementExternalReferences), Object.values(workspaceRef.elementRevisionReferences)]
        .flat(2)
        .filter((e) => !!e.documentId)
        .map((e) => e.documentId)
        .forEach((e) => documentExtRefs.add(e));
    }
    LOG.debug(`Document Id=${doc.id} ExternalReferences=${Array.from(documentExtRefs)}`);
    documentExtRefs.delete(doc.id);
    return documentExtRefs;
  }

  private async writetoCsv(doc: DocumentNode) {
    const aDocument: Record<string, unknown> = {};
    aDocument.id = doc.id || 'Unknown';
    aDocument.name = doc.name || 'Unknown';
    aDocument.description = doc.description || '';
    const folder = this.docToParent.get(doc.id);
    aDocument.folderId = folder ? folder.id : '';
    aDocument.folderName = folder ? folder.name : '';
    aDocument.outSide = folder ? 'No' : 'Yes';
    aDocument.docOwnerId = doc.owner && doc.owner.id ? doc.owner.id : 'Unknown';
    aDocument.docOwnerName = doc.owner && doc.owner.name ? doc.owner.name : 'Unknown';
    aDocument.docCreator = doc.createdBy && doc.createdBy.name ? doc.createdBy.name : 'Unknown';
    aDocument.docModifier = doc.modifiedBy && doc.modifiedBy.name ? doc.modifiedBy.name : 'Unknown';
    await writeDocumentReferences(aDocument);
  }

  private async processDocument(input: DocumentNode | string): Promise<boolean> {
    const docId = typeof input === 'string' ? input : input.id;
    if (this.processedDocs.has(docId)) {
      return false;
    }
    this.allDocIds.add(docId);
    try {
      let doc: DocumentNode = typeof input === 'string' ? null : input;
      let foundDoc = true;
      if (!doc) {
        try {
          doc = await this.apiClient.get(`api/documents/${docId}`) as DocumentNode;
        } catch {
          foundDoc = false;
          doc = {
            name: 'Unknown', id: docId
          };
        }
      }

      this.processedDocs.set(docId, doc);
      await this.writetoCsv(doc);
      if (!foundDoc) {
        return false;
      }

      const fileName = `${OUTPUT_FOLDER}/document_${doc.id}.json`;
      await fs.writeFile(fileName, JSON.stringify(doc, null, 2));

      LOG.info(`  Processing document id = ${doc.id} ${doc.name}`);
      const documentExtRefs = await this.getExternalReferences(doc);

      documentExtRefs.forEach((docId) => this.allDocIds.add(docId));
      this.docToExtRef.set(doc.id, documentExtRefs);
    } catch (error) {
      LOG.error(`Processing document=${docId} failed`, error);
      return false;
    }
    return true;
  }

  public async processRemainingDocs() {
    let foundMore = true;
    let passCount = 0;
    while (foundMore) {
      passCount++;
      foundMore = false;
      LOG.info(`Process non folder document pass = ${passCount}`);
      for (const docId of this.allDocIds.values()) {
        const unProcessed = await this.processDocument(docId);
        foundMore = foundMore || unProcessed;
      }
    }
  }

  public async processFolder(folderId: string) {
    let folder = null;
    try {
      folder = await this.apiClient.get(`api/folders/${folderId}`) as BasicNode;
    } catch (e) {
      LOG.error(`Invalid folderId = ${folderId}`);
      return;
    }

    LOG.info(`Processing folder id = ${folder.id} name = ${folder.name}`);
    this.processedFolders.set(folder.id, folder);

    let docRequest = `api/globaltreenodes/folder/${folderId}`;
    while (docRequest) {
      const nodeList = await this.apiClient.get(docRequest) as GlobalNodeList;
      for (const node of nodeList.items) {
        if (node.jsonType === DOCUMENT_SUMMARY) {
          this.folderDocs.set(node.id, node);
          this.docToParent.set(node.id, folder);
          this.allDocIds.add(node.id);
          await this.processDocument(node);
        } else if (node.jsonType === FOLDER) {
          await this.processFolder(node.id);
        }
      }
      docRequest = nodeList.next;
    }
  }
}


try {
  const stackToUse: string = ArgumentParser.get('stack');
  let folderId: string = ArgumentParser.get('folder');
  if (!folderId) {
    throw new Error('Please specify --folder=XXX as argument');
  }

  folderId = folderId.toString();
  if (!folderId.match(/^[0-9a-fA-F]{24}$/)) {
    throw new Error('folder argument is not a valid Onshape folderId');
  }

  const apiClient = await ApiClient.createApiClient(stackToUse);

  const report = new SummaryReport(apiClient);

  await report.processFolder(folderId);
  await report.processRemainingDocs();

  await report.printReport();
} catch (error) {
  console.error(error);
  LOG.error('Processing folder failed', error);
}
