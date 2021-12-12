import { mainLog } from './utils/logger';
import * as minimist from 'minimist';
import * as fs from 'fs';
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

const LOG = mainLog();
const OUTPUT_FOLDER = './output';
const csvReport = './references.csv';

class SummayReport {
  private allDocsById = new Map<string, DocumentNode>();
  private docToExtRef = new Map<string, DocumentNode[]>();
  private processedDocs = new Map<string, DocumentNode>();
  private processedFolders = new Map<string, BasicNode>();
  private docToParent = new Map<string, BasicNode>();
  private folderDocs = new Map<string, DocumentNode>();

  public printReport() {
    LOG.info('Processed folder count=', this.processedFolders.size);
    LOG.info('Processed doc in folder count=', this.folderDocs.size);
    LOG.info('Processed document count=', this.processedDocs.size);
    LOG.info('Encountered document count=', this.allDocsById.size);

    const outSideDocuments = Array.from(this.allDocsById.values()).filter((d) => !this.folderDocs.has(d.id));

    for (const doc of outSideDocuments) {
      LOG.info(`Outside doc id=${doc.id} name=${doc.name} description=${doc.description}`);
    }

    fs.writeFileSync(csvReport, 'DocumentId, DocumentName, Description, FolderId , FolderName, Outside, OwnerId, OwnerName, Created By, Modified By\n');
    for (const doc of this.allDocsById.values()) {
      let line: string[] = [];
      line.push(doc.id || '');
      line.push(doc.name || '');
      line.push(doc.description || '');
      const folder = this.docToParent.get(doc.id);
      const folderId = folder ? folder.id : '';
      const folderName = folder ? folder.name : '';
      line.push(folderId, folderName);
      line.push(folder ? 'No' : 'Yes');
      const docOwnerId = doc.owner && doc.owner.id ? doc.owner.id : '';
      const docOwnerName = doc.owner && doc.owner.name ? doc.owner.name : '';
      const docCreator = doc.createdBy && doc.createdBy.name ? doc.createdBy.name : '';
      const docModifier = doc.modifiedBy && doc.modifiedBy.name ? doc.modifiedBy.name : '';
      line.push(docOwnerId, docOwnerName, docCreator, docModifier);
      line = line.map((x) => x.replaceAll(',', '_'));
      fs.appendFileSync(csvReport, line.join(',') + '\n');
    }
  }

  public constructor(private apiClient: ApiClient) { }

  private async getExternalReferences(doc: DocumentNode) {
    const docById = new Map<string, DocumentNode>();
    const workspacesReq = `api/documents/d/${doc.id}/workspaces`;
    const workspaceList = await this.apiClient.get(workspacesReq) as BasicNode[];
    for (const workspace of workspaceList) {
      const fileName = `${OUTPUT_FOLDER}/workspace_${workspace.id}.json`;
      LOG.info(`    Processing workspace=${workspace.id} name=${workspace.name}`);
      let workspaceRef: WorkspaceRef = null;
      if (fs.existsSync(fileName)) {
        workspaceRef = JSON.parse(fs.readFileSync(fileName, 'utf8') as string);
      } else {
        workspaceRef = await this.apiClient.get(`api/documents/d/${doc.id}/w/${workspace.id}/externalreferences`) as WorkspaceRef;
        fs.writeFileSync(fileName, JSON.stringify(workspaceRef, null, 2));
      }
      if (workspaceRef.documents) {
        for (const doc of workspaceRef.documents) {
          docById.set(doc.id, doc);
        }
      }
    }
    return docById;
  }

  private async processDocument(doc: DocumentNode): Promise<boolean> {
    if (this.processedDocs.has(doc.id)) {
      return false;
    }

    const fileName = `${OUTPUT_FOLDER}/document_${doc.id}.json`;
    fs.writeFileSync(fileName, JSON.stringify(doc, null, 2));

    LOG.info(`  Processing document id=${doc.id} ${doc.name} description=${doc.description}`);
    this.allDocsById.set(doc.id, doc);
    this.processedDocs.set(doc.id, doc);
    const docById = await this.getExternalReferences(doc);

    for (const doc of docById.values()) {
      if (this.allDocsById.has(doc.id)) {
        continue;
      }
      this.allDocsById.set(doc.id, doc);
    }
    this.docToExtRef.set(doc.id, Array.from(docById.values()));
    return true;
  }

  private async processRemainingDocs() {
    let foundMore = true;
    let passCount = 0;
    while (foundMore) {
      passCount++;
      foundMore = false;
      LOG.info(`Process non folder document pass=${passCount}`);
      for (const doc of this.allDocsById.values()) {
        const unProcessed = await this.processDocument(doc);
        foundMore = foundMore || unProcessed;
      }
    }
  }

  public async processFolder(folderId: string) {
    let folder = null;
    try {
      folder = await this.apiClient.get(`api/folders/${folderId}`) as BasicNode;
    } catch (e) {
      LOG.error(`Invalid folderId=${folderId}`);
      return;
    }

    LOG.info(`Processing folder id=${folder.id} name=${folder.name}`);
    this.processedFolders.set(folder.id, folder);

    let docRequest = `api/globaltreenodes/folder/${folderId}`;
    while (docRequest) {
      const nodeList = await this.apiClient.get(docRequest) as GlobalNodeList;
      for (const node of nodeList.items) {
        if (node.jsonType === DOCUMENT_SUMMARY) {
          await this.processDocument(node);
          this.folderDocs.set(node.id, node);
          this.docToParent.set(node.id, folder);
        } else if (node.jsonType === FOLDER) {
          await this.processFolder(node.id);
        }
      }
      docRequest = nodeList.next;
    }

    await this.processRemainingDocs();
  }
}


/**
 * This is the main entry point
 */
void async function () {
  try {
    mkdirp.sync(OUTPUT_FOLDER);
    if (fs.existsSync(csvReport)) {
      fs.unlinkSync(csvReport);
    }

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
    report.printReport();
  } catch (error) {
    console.error(error);
    LOG.error('Processing folder failed', error);
  }
}();
