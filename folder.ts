import { mainLog } from './utils/logger';
import * as minimist from 'minimist';
import { promises as fs } from 'fs';
import { constants } from 'fs';
import * as mkdirp from 'mkdirp';
import {
  BasicNode,
  DocumentNode,
  DOCUMENT_SUMMARY,
  FOLDER,
  GlobalNodeList,
  WorkspaceRef
} from './utils/onshapetypes';
import { ApiClient } from './utils/apiclient';
import { CsvFileWriter } from './utils/csvFile';

const LOG = mainLog();
const OUTPUT_FOLDER = './output';
const csvReport = './references.csv';

class SummayReport {
  private allDocIds = new Set<string>();
  private docToExtRef = new Map<string, Set<string>>();
  private processedDocs = new Map<string, DocumentNode>();
  private processedFolders = new Map<string, BasicNode>();
  private docToParent = new Map<string, BasicNode>();
  private folderDocs = new Map<string, DocumentNode>();
  private csvWriter = new CsvFileWriter(csvReport);

  public async printReport() {
    LOG.info('Processed folder count=', this.processedFolders.size);
    LOG.info('Processed doc in folder count=', this.folderDocs.size);
    LOG.info('Processed document count=', this.processedDocs.size);
    LOG.info('Encountered document count=', this.allDocIds.size);
  }

  public constructor(private apiClient: ApiClient) { }

  private async getExternalReferences(doc: DocumentNode): Promise<Set<string>> {
    const documentExtRefs = new Set<string>();
    const workspacesReq = `api/documents/d/${doc.id}/workspaces`;
    const workspaceList = await this.apiClient.get(workspacesReq) as BasicNode[];
    for (const workspace of workspaceList) {
      const fileName = `${OUTPUT_FOLDER}/workspace_${workspace.id}_document_${doc.id}.json`;
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

      if (workspaceRef.elementExternalReferences) {
        const extRefs = Object.values(workspaceRef.elementExternalReferences);
        extRefs.forEach((e) => {
          if (e && e.length > 0) {
            e.forEach((i) => {
              if (i.documentId) {
                this.allDocIds.add(i.documentId);
              }
            });
          }
        });
      }
      if (workspaceRef.elementRevisionReferences) {
        const extRefs = Object.values(workspaceRef.elementRevisionReferences);
        extRefs.forEach((e) => {
          if (e && e.length > 0) {
            e.forEach((i) => {
              if (i.documentId) {
                this.allDocIds.add(i.documentId);
              }
            });
          }
        });
      }
    }
    documentExtRefs.delete(doc.id);
    return documentExtRefs;
  }

  private async writetoCsv(doc: DocumentNode) {
    if (!this.csvWriter.isInitialized) {
      const CSV_HEADERS = ['DocumentId', 'DocumentName', 'Description', 'FolderId ', 'FolderName', 'Outside', 'OwnerId', 'OwnerName', 'Created By', 'Modified By'];
      await this.csvWriter.writeHeaders(CSV_HEADERS);
    }

    const line: string[] = [];
    line.push(doc.id || 'Unknown');
    line.push(doc.name || 'Unknown');
    line.push(doc.description || '');
    const folder = this.docToParent.get(doc.id);
    const folderId = folder ? folder.id : '';
    const folderName = folder ? folder.name : '';
    line.push(folderId, folderName);
    line.push(folder ? 'No' : 'Yes');
    const docOwnerId = doc.owner && doc.owner.id ? doc.owner.id : 'Unknown';
    const docOwnerName = doc.owner && doc.owner.name ? doc.owner.name : 'Unknown';
    const docCreator = doc.createdBy && doc.createdBy.name ? doc.createdBy.name : 'Unknown';
    const docModifier = doc.modifiedBy && doc.modifiedBy.name ? doc.modifiedBy.name : 'Unknown';
    line.push(docOwnerId, docOwnerName, docCreator, docModifier);
    await this.csvWriter.writeLine(line);
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

      LOG.info(`  Processing document id = ${doc.id} ${doc.name} description = ${doc.description}`);
      const documentExtRefs = await this.getExternalReferences(doc);

      documentExtRefs.forEach((docId) => this.allDocIds.add(docId));
      this.docToExtRef.set(doc.id, documentExtRefs);
    } catch {
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


/**
 * This is the main entry point
 */
void async function () {
  try {
    mkdirp.sync(OUTPUT_FOLDER);

    const argv = minimist(process.argv.slice(2));
    const stackToUse: string = argv['stack'];
    let folderId: string = argv['folder'];
    if (!folderId) {
      throw new Error('Please specify --folder as argument');
    }
    folderId = folderId.toString();
    if (!folderId.match(/^[0-9a-fA-F]{24}$/)) {
      throw new Error('folder id is not a valid Onshape folderId');
    }

    const apiClient = await ApiClient.createApiClient(stackToUse);

    const report = new SummayReport(apiClient);

    await report.processFolder(folderId);
    await report.processRemainingDocs();

    report.printReport();
  } catch (error) {
    console.error(error);
    LOG.error('Processing folder failed', error);
  }
}();
