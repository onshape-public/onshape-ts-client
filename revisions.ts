import { mainLog } from './utils/logger.js';
import { ArgumentParser } from './utils/argumentparser.js';
import { ApiClient } from './utils/apiclient.js';
import { writeRevision } from './utils/csvFile.js';
import { ListResponse, Revision } from './utils/onshapetypes.js';

const LOG = mainLog();

async function findAllRevisions(apiClient: ApiClient, companyId: string, findAll: boolean) {
  const latestOnlyValue = findAll ? 'false' : 'true';
  let nextBatchUri = `api/revisions/companies/${companyId}?latestOnly=${latestOnlyValue}`;
  let totalRevCount = 0;
  while (nextBatchUri) {
    LOG.info(`Calling ${nextBatchUri}`);
    const revsResponse = await apiClient.get(nextBatchUri) as ListResponse<Revision>;
    if (revsResponse.items) {
      totalRevCount += revsResponse.items.length;
      LOG.info(`Found total revisions = ${totalRevCount}`);
      for (const rev of revsResponse.items) {
        await writeRevision(rev);
      }
    }
    nextBatchUri = revsResponse.next;
  }
}

try {
  const stackToUse: string = ArgumentParser.get('stack');
  const findAll: boolean = ArgumentParser.get('all');
  const apiClient = await ApiClient.createApiClient(stackToUse);
  const companyInfo = await apiClient.findCompanyInfo();
  if (!companyInfo.admin) {
    throw new Error('Company admin permission required');
  }
  await findAllRevisions(apiClient, companyInfo.id, findAll);
} catch (error) {
  console.error(error);
  LOG.error('Enumerating all revisions failed', error);
}
