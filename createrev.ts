import { promises as fs } from 'fs';
import { FolderType, getFolderPath } from './utils/fileutils.js';
import { mainLog } from './utils/logger.js';
import { ArgumentParser } from './utils/argumentparser.js';
import { ApiClient } from './utils/apiclient.js';
import {
  BasicNode,
  Constants,
  ElementMetadata,
  ElementType,
  ErrorSeverity,
  PropertyUpdate,
  PROPERTY_TYPES,
  ReleasePackage,
  ReleasePackageItem,
  ReleasePackageItemUpdate
} from './utils/onshapetypes.js';

const LOG = mainLog();
const OUTPUT_FOLDER = getFolderPath(FolderType.OUTPUT);

/**
 * Release Package only releases unreleased and revision managed items.  If any of the items have errors
 * the package transition will also fail.
 * @param {ReleasePackageItem} rpItem An item of the package
 */
function isItemValidForPackage(rpItem: ReleasePackageItem): boolean {
  let hasWarnOrError = false;
  for (const error of rpItem.errors) {
    LOG.info(`itemId=${rpItem.id} has message="${error.message}"`);
    if (error.severity > ErrorSeverity.INFO) {
      hasWarnOrError = true;
    }
  }

  const properties = rpItem.properties;
  const nrmProperty = properties.find((p) => p.propertyId === Constants.NOT_REVISION_MANAGED_ID);
  if (nrmProperty && nrmProperty.value === true) {
    return false;
  }
  const isIncluded = properties.find((p) => p.propertyId === Constants.INCLUDED_IN_RELEASE_PACKAGE_PROPERTY_ID);
  if (isIncluded && isIncluded.value === false) {
    return false;
  }
  return !hasWarnOrError;
}

/**
 * Filter out all invalid items from the package and return a flat list of valid items
 */
function collectValidItems(rpItems: ReleasePackageItem[], input: ReleasePackageItem[] = []) {
  const filteredItems = rpItems.filter((i) => isItemValidForPackage(i));
  input.push(...filteredItems);
  filteredItems.forEach((i) => collectValidItems(i.children, input));
  return input;
}


/**
 * Lookup property value by its guid in a package item
 */
function getItemPropertyValue(item: ReleasePackageItem, propertyId: string): PROPERTY_TYPES {
  const property = item.properties.find((p) => p.propertyId === propertyId);
  return property ? property.value : null;
}

async function releaseItems(apiClient: ApiClient) {
  const docUri: string = ArgumentParser.get('docuri');
  if (!docUri) {
    throw new Error('--docuri=http://cad.onshape.com/documents/xxx argument is required');
  }

  LOG.info(`Processing docuri=${docUri}`);
  let url: URL = null;
  try {
    url = new URL(docUri);
  } catch (error) {
    throw new Error(`Failed to parse ${docUri} as valid URL`);
  }

  const lowerCasePath = url.pathname.toLowerCase();
  const regexMatch = lowerCasePath.match(/^\/documents\/([0-9a-f]{24})\/([wv])\/([0-9a-f]{24})\/e\/([0-9a-f]{24})$/);
  if (!regexMatch) {
    throw new Error(`Failed to extract documentId and elementId from ${lowerCasePath}`);
  }

  const documentId: string = regexMatch[1];
  const wv = regexMatch[2];
  const workspaceId: string = wv == 'w' ? regexMatch[3] : null;
  const versionId: string = wv == 'v' ? regexMatch[3] : null;
  const elementId: string = regexMatch[4];
  let configuration: string = url.searchParams.get('configuration') || null;
  let partId: string = ArgumentParser.get('pid');

  // Use configuration from either the doc uri or input
  const inputConfiguration: string = ArgumentParser.get('configuration');
  if (inputConfiguration) {
    if (configuration) {
      throw new Error('--configuration=XXX should not be specified if --docuri has configuation as query param');
    }
    configuration = inputConfiguration;
  }

  // The depth allows one to get element and its parts metadata data with a single api call
  const metadataUrl = lowerCasePath.replace('/documents/', 'api/metadata/d/') + '?depth=2';
  const elementMetadata = await apiClient.get(metadataUrl) as ElementMetadata;
  await fs.writeFile(`${OUTPUT_FOLDER}/metadata_${elementId}.json`, JSON.stringify(elementMetadata, null, 2));

  if (elementMetadata.elementType === ElementType.PARTSTUDIO && !partId) {
    const part = elementMetadata.parts.items.find((p) => p.partType === 'solid');
    partId = part.partId;
  }

  LOG.info(`documentId=${documentId}, workspaceId=${workspaceId}, versionId=${versionId}, elementId=${elementId}, partId=${partId} configuration=${configuration}`);

  /**
   * To create a release package you need to specify a list of top level items. If the creation is successfull
   * each item returned will have its properties and children.
   */
  const rpCreateBody = {
    items: [
      {
        documentId: documentId,
        workspaceId: workspaceId,
        versionId: versionId,
        elementId: elementId,
        partId: partId,
        configuration: configuration
      }
    ]
  };

  LOG.info('Creating release package with body', rpCreateBody);
  const releasePackage = await apiClient.post(`/api/releasepackages/release/${Constants.ONSHAPE_WORKFLOW_ID}`, rpCreateBody) as ReleasePackage;

  await fs.writeFile(`${OUTPUT_FOLDER}/rp_create_${releasePackage.id}.json`, JSON.stringify(releasePackage, null, 2));

  // To transition we need flatten the item and its children and only include revision managed and not already released items
  const items = collectValidItems(releasePackage.items);
  if (items.length === 0) {
    throw new Error(`No items found to release in rpId=${releasePackage.id}`);
  }

  LOG.info('Items left to release count=', items.length);

  // This is the basic post body for transitioning a package. You need to specify any package properties
  // and all items in a flat list with only properties that you intend to change
  const releaseBody = {
    properties: [] as PropertyUpdate[],
    items: [] as ReleasePackageItemUpdate[]
  };

  for (const item of items) {
    const itemUpdate: ReleasePackageItemUpdate = {
      id: item.id,
      href: item.href,
      documentId: item.documentId,
      workspaceId: item.workspaceId,
      versionId: item.versionId,
      elementId: item.elementId,
      properties: [] as PropertyUpdate[]
    };
    const name = getItemPropertyValue(item, Constants.NAME_ID);
    const partNumber = getItemPropertyValue(item, Constants.PART_NUMBER_ID);
    const revision = getItemPropertyValue(item, Constants.REVISION_ID);
    LOG.info(`On Item=${item.id} found name=${name} partNumber="${partNumber}" revision="${revision}"`);

    // Override if input revision if needed
    const revisionToRelease = ArgumentParser.get('revision') as PROPERTY_TYPES || revision;
    if (!revisionToRelease) {
      throw new Error(`Failed to determine revision for Item=${item.id}`);
    }
    itemUpdate.properties.push({ propertyId: Constants.REVISION_ID, value: revisionToRelease });
    const partNumberToUse = ArgumentParser.get('partnumber') as PROPERTY_TYPES || partNumber;
    if (!partNumberToUse) {
      throw new Error(`Failed to determine partNumber for Item=${item.id} name=${name}`);
    }
    if (partNumberToUse !== partNumber) {
      itemUpdate.properties.push({ propertyId: Constants.PART_NUMBER_ID, value: partNumberToUse });
    }
    releaseBody.items.push(itemUpdate);
  }

  let releaseName: string = ArgumentParser.get('releasename');
  if (!releaseName) {
    if (versionId) { // If name is not specified and we are releasing a version use the version name
      const versionInfo = await apiClient.get(`api/documents/d/${documentId}/versions/${versionId}`) as BasicNode;
      releaseName = versionInfo.name;
    }
  }
  releaseBody.properties.push(
    { propertyId: Constants.RP_NAME_ID, value: releaseName || 'Automated Release' }
  );
  releaseBody.properties.push(
    { propertyId: Constants.RP_NOTES_ID, value: `Released by createrev.ts on ${new Date().toString()}` }
  );

  LOG.info(`Doing CREATE_AND_RELEASE for rpId=${releasePackage.id}`, JSON.stringify(releaseBody, null, 2));
  const releaseResponse = await apiClient.post(`/api/releasepackages/${releasePackage.id}?wfaction=CREATE_AND_RELEASE`, releaseBody);
  await fs.writeFile(`${OUTPUT_FOLDER}/rp_transition_${releasePackage.id}.json`, JSON.stringify(releaseResponse, null, 2));
  LOG.info('CREATE_AND_RELEASE Was success');
}

try {
  const stackToUse: string = ArgumentParser.get('stack');
  const apiClient = await ApiClient.createApiClient(stackToUse);
  await releaseItems(apiClient);
} catch (error) {
  console.error(error);
  LOG.error('Creating revision failed', error);
}
