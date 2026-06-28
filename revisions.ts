import { mainLog } from './utils/logger.js';
import { ArgumentParser } from './utils/argumentparser.js';
import { ApiClient } from './utils/apiclient.js';
import { writeRevision } from './utils/csvFile.js';
import { ListResponse, Revision } from './utils/onshapetypes.js';

const LOG = mainLog();

async function findAllRevisions(apiClient: ApiClient, companyId: string, findAll: boolean) {
  const processedRevisions: Record<string, string> = {};
  const latestOnlyValue = findAll ? 'false' : 'true';
  let nextBatchUri = `api/revisions/companies/${companyId}?latestOnly=${latestOnlyValue}`;
  while (nextBatchUri) {
    LOG.info(`Calling ${nextBatchUri}`);
    const revsResponse = await apiClient.get(nextBatchUri) as ListResponse<Revision>;
    let newRevCount = 0;
    if (revsResponse.items) {
      for (const rev of revsResponse.items) {
        if (processedRevisions[rev.id]) {
          continue;
        }

        processedRevisions[rev.id] = rev.createdAt;
        newRevCount++;
        await writeRevision(rev);
      }
    }
    if (newRevCount === 0) {
      break;
    }
    LOG.info(`Found new revisions = ${newRevCount}`);
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
