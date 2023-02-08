import { mainLog } from './utils/logger.js';
import { ArgumentParser } from './utils/argumentparser.js';
import { ApiClient } from './utils/apiclient.js';
import { writeWorkflowObject } from './utils/csvFile.js';
import { BasicNode, ListResponse, ReleasePackage } from './utils/onshapetypes.js';
import { writeReleasePackage, writeTask } from './utils/csvFile.js';

const LOG = mainLog();

/** Basic response of workflowable object. This is basically a summary */
interface ObjectWorkflow extends BasicNode {
  objectType: 'RELEASE' | 'TASK' | 'OBSOLETION';
  state: 'PENDING' | 'RELEASED' | 'OBSOLETE' | 'REJECTED' | 'OPEN' | 'COMPLETE' | 'SETUP';
  metadataState: 'IN_PROGRESS' | 'PENDING' | 'RELEASED' | 'OBSOLETE' | 'REJECTED';
  canBeDiscarded: boolean;
  isDiscarded: boolean;
  isFrozen: boolean;
  /** Extended information about specific type of object like RELEASE or TASK */
  href: string;
}

async function findAllWorkflowableObjects(apiClient: ApiClient, companyId: string, objectTypes: string[], states: string[]) {
  const queryParams = new URLSearchParams();
  objectTypes.forEach(a => queryParams.append('objectTypes', a));
  states.forEach(a => queryParams.append('states', a));

  let nextBatchUri = `api/workflow/companies/${companyId}/objects?` + queryParams.toString();
  let totalCount = 0;
  while (nextBatchUri) {
    LOG.info(`Calling ${nextBatchUri}`);
    const wfResponse = await apiClient.get(nextBatchUri) as ListResponse<ObjectWorkflow>;
    if (wfResponse.items) {
      totalCount += wfResponse.items.length;
      LOG.info(`Found total workflow objects = ${totalCount}`);
      for (const wfObject of wfResponse.items) {
        try {
          if (wfObject.href) {
            if (wfObject.objectType === 'RELEASE' || wfObject.objectType === 'OBSOLETION') {
              const releasePackage = await apiClient.get(wfObject.href) as ReleasePackage;
              wfObject.name = releasePackage.name;
              writeReleasePackage(releasePackage);
            } else if (wfObject.objectType === 'TASK') {
              const task = await apiClient.get(wfObject.href) as BasicNode;
              wfObject.name = task.name;
              writeTask(task);
            }
          }
        } catch (error) {
          LOG.error(`Error fetching ${wfObject.href}`);
        }
        await writeWorkflowObject(wfObject);
      }
    }
    nextBatchUri = wfResponse.next;
  }
}

try {
  const stackToUse: string = ArgumentParser.get('stack');
  const states: string[] = ArgumentParser.getArray('state');
  const objectTypes: string[] = ArgumentParser.getArray('objectType');
  const apiClient = await ApiClient.createApiClient(stackToUse);
  const companyInfo = await apiClient.findCompanyInfo();
  if (!companyInfo.admin) {
    throw new Error('Company admin permission required');
  }
  LOG.info(`Fetching objectTypes=${objectTypes} states=${states}`);
  await findAllWorkflowableObjects(apiClient, companyInfo.id, objectTypes, states);
} catch (error) {
  console.error(error);
  LOG.error('Enumerating all workflow objects failed', error);
}
