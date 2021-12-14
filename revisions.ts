import { mainLog } from './utils/logger';
import { promises as fs } from 'fs';
import * as mkdirp from 'mkdirp';

import { ArgumentParser } from './utils/argumentparser';
import { ApiClient } from './utils/apiclient';
import { CsvFileWriter } from './utils/csvFile';
import {
  GlobalNodeList,
  Revision,
} from './utils/onshapetypes';

const LOG = mainLog();
const OUTPUT_FOLDER = './output';
const csvWriter = new CsvFileWriter('./revisions.csv');

async function writetoCsv(rev: Revision) {
  if (!csvWriter.isInitialized) {
    const CSV_HEADERS = ['RevisionId', 'Part Number', 'Revision', 'CompanyId', 'Document Id', 'Version Id',
      'Element Id', 'Part Id', 'Element Type', 'Configuration', 'Mime Type', 'Created At', 'ViewRef'];
    await csvWriter.writeHeaders(CSV_HEADERS);
  }

  await csvWriter.writeLine([
    rev.id, rev.partNumber, rev.revision, rev.companyId, rev.documentId, rev.versionId,
    rev.elementId, rev.partId, rev.elementType, rev.configuration, rev.mimeType, rev.createdAt, rev.viewRef
  ]);
}

async function findAllRevisions(apiClient: ApiClient, companyId: string, findAll: boolean) {
  const latestOnlyValue = findAll ? 'false' : 'true';
  let nextBatchUri = `api/revisions/companies/${companyId}?latestOnly=${latestOnlyValue}`;
  let totalRevCount = 0;
  while (nextBatchUri) {
    LOG.info(`Calling ${nextBatchUri}`);
    const revsResponse = await apiClient.get(nextBatchUri) as GlobalNodeList;
    if (revsResponse.items) {
      totalRevCount += revsResponse.items.length;
      LOG.info(`Found total revisions = ${totalRevCount}`);
      for (const rev of revsResponse.items) {
        const fileName = `${OUTPUT_FOLDER}/revision_${rev.id}.json`;
        await fs.writeFile(fileName, JSON.stringify(rev, null, 2));
        await writetoCsv(rev as Revision);
      }
    }
    nextBatchUri = revsResponse.next;
  }
}

/**
 * This is the main entry point
 */
void async function () {
  try {
    await mkdirp.manual(OUTPUT_FOLDER);
    const stackToUse: string = ArgumentParser.get('stack');
    const findAll: boolean = ArgumentParser.get('all');
    let companyId: string = ArgumentParser.get('companyId');
    const apiClient = await ApiClient.createApiClient(stackToUse);

    if (!companyId) {
      const companiesInfo = await apiClient.get('/api/companies') as GlobalNodeList;
      const companyCount = companiesInfo.items && companiesInfo.items.length || 0;
      if (companyCount == 0) {
        throw new Error('No company membership found');
      } else if (companyCount > 1) {
        throw new Error('User is member of mutliple companies. Please specify --companyId=XXXX as argument');
      }
      companyId = companiesInfo.items[0].id;
    }
    await findAllRevisions(apiClient, companyId, findAll);
  } catch (error) {
    console.error(error);
    LOG.error('Processing folder failed', error);
  }
}();
