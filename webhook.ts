import { mainLog } from './utils/logger.js';
import localtunnel from 'localtunnel';
import ngrok from 'ngrok';
import express, { Application, Request, Response } from 'express';
import { ArgumentParser } from './utils/argumentparser.js';
import { ApiClient } from './utils/apiclient.js';
import { writeReleasePackage, writeRevision, writeVersion, writeNotification } from './utils/csvFile.js';
import { BasicNode, ElementType, ListResponse, Revision, ReleasePackage } from './utils/onshapetypes.js';
import { TranslationHelper } from './utils/translationhelper.js';
import { terminationHandler } from './utils/terminationhandler.js';

const LOG = mainLog();

let apiClient: ApiClient = null;
let translationHelper: TranslationHelper = null;

/** Common to both webhook post params and response */
interface WebHookCommon {
  /** id of the webhook */
  id?: string;

  /** A unique string to identify the webhook. Part of every event and response */
  data: string;

  /** company admins can install webhooks to listen to all company level events */
  companyId?: string;

  /** Only listen to events originating from a single specified document */
  documentId?: string;

  /** Only listen to events originating from a specified project and its documents */
  projectId?: string;

  /** Only listen to events originating from a specified folder and its documents */
  folderId?: string;

  /** Publicly accessible URL that onshape.com will post webhook events to  */
  url: string;
}

/** GET/POST response for creating or updating a webhook */
interface WebHookInfo extends WebHookCommon {
  /** Application client id the web hook is attached to, can be null */
  clientId?: string;

  versionId: string;
  workspaceId: string;
  elementId: string;
}

/** POST params for creating or updating a webhook */
interface WebHookParams extends WebHookCommon {
  /** list of options, Only supported is collapseEvents = true  */
  options: Record<string, boolean>;

  /** List of events that webhook will notify you about */
  events: string[];

  /** Use these to restrict the scope of documentId notifications */
  versionId?: string;
  workspaceId?: string;
  elementId?: string;
}

/** Schema for the webhook events */
interface WebHookEvent {
  jsonType: 'lifecycle' | 'document' | 'workflow' | 'revision';
  /** Registered webhook data simply relayed back */
  data: string;
  /** One of the type of events that was registered as interesting */
  event: string;
  messageId: string;
  timestamp: string;
  webhookId: string;
  /** document in which the event happened */
  documentId?: string;
  versionId?: string;
  /** Revision Id in case event is onshape.revision.created */
  revisionId?: string;
  /** Completed translation job id if event is onshape.model.translation.complete */
  translationId?: string;

  /** Workflowable object id and type if event is onshape.workflow.transition */
  objectId?: string;
  objectType?: string;
}

/** A simple node express app listening on a port for webhook notifications from onshape */
const PORT: number = ArgumentParser.get('port', 9191);
const app: Application = express();
app.use(express.json());
app.listen(PORT, (): void => {
  LOG.info(`Listening to webhook events on port:${PORT} processid=${process.pid}`);
});

/** post route for all webhooks received from onshape */
app.post('/onshapeevents', (req: Request, res: Response): void => {
  const eventJson = req.body as WebHookEvent;
  res.status(200).end();
  handleWebhookEvent(eventJson);
});

/** Simple http://localhost:9191/status end for health check of express */
app.get('/status', (_req: Request, res: Response): void => {
  res.send(`Webhook sample status is OK running on ${PORT}`);
});

/**
 * Callback for all webhook events received.
 *
 * Revisions, versions and release packages are saved to reports/*.csv
 * Part revisions are exported to STEP
 * Drawing revisions are exported to PDF
 *
 * @param eventJson The event that onshape relayed on the installed webhook
 */
async function handleWebhookEvent(eventJson: WebHookEvent) {
  try {
    LOG.info('Received webhook event', eventJson);
    writeNotification(eventJson);
    switch (eventJson.event) {
    case 'onshape.revision.created': {
      const newRev = await apiClient.get(`api/revisions/${eventJson.revisionId}`) as Revision;
      LOG.trace('Newly created Revision', newRev);
      writeRevision(newRev);
      if (newRev.elementType === ElementType.DRAWING) {
        await translationHelper.exportDrawingRevision(newRev);
      } else if (newRev.elementType === ElementType.PARTSTUDIO) {
        await translationHelper.exportPartRevisionSync(newRev);
      }
      break;
    }
    case 'onshape.workflow.transition': {
      if (eventJson.objectType === 'RELEASE') {
        const rpId = eventJson.objectId;
        const releasePackage = await apiClient.get(`api/releasepackages/${rpId}`) as ReleasePackage;
        writeReleasePackage(releasePackage);
      }
      break;
    }
    case 'onshape.model.lifecycle.createversion': {
      const documentId = eventJson.documentId;
      const versionId = eventJson.versionId;
      if (documentId && versionId) {
        const newVersion = await apiClient.get(`api/documents/d/${documentId}/versions/${versionId}`) as BasicNode;
        await writeVersion(newVersion);
      }
      break;
    }
    case 'onshape.model.translation.complete': {
      await translationHelper.downloadTranslation(eventJson.translationId);
      break;
    }
    }
  } catch (error) {
    LOG.error('Webhook event processing error', error);
  }
}

/**
 * Returns the URL that will be used to install the webhook. Either uses
 * the specified URL or uses either ngrok or localtunnel to create a tunnel
 * that onshape can use to relay message to the machine running this script.
 */
async function getWebhookListenURL(): Promise<string> {
  const webhookUri: string = ArgumentParser.get('webhookuri');
  if (webhookUri) {
    LOG.info(`Using webhookuri [${webhookUri}] => [http://localhost:${PORT}]`);
    return webhookUri;
  }

  const useLocalTunnel: boolean = ArgumentParser.get('localtunnel');
  if (useLocalTunnel) {
    const tunnel = await localtunnel(PORT);
    terminationHandler.createdTunnel = tunnel;
    LOG.info(`Established local tunnel [${tunnel.url}] => [http://localhost:${PORT}]`);
    return `${tunnel.url}/onshapeevents`;
  }

  const useNgrok: boolean = ArgumentParser.get('ngrok', true);
  if (useNgrok) {
    const ngrokUrl = await ngrok.connect(PORT);
    LOG.info(`Established ngrok tunnel [${ngrokUrl}] => [http://localhost:${PORT}]`);
    return `${ngrokUrl}/onshapeevents`;
  }

  throw new Error('One of --webhookuri, or --ngrok or localtunnel needs to be specified');
}

/**
 * Registers the webhook against a onshape company or document.
 */
async function registerWebhook(apiClient: ApiClient) {
  const webhookListenURL = await getWebhookListenURL();

  const companyInfo = await apiClient.findCompanyInfo();
  let webhookFindUri = 'api/webhooks';
  if (companyInfo.admin) {
    webhookFindUri += `?company=${companyInfo.id}`;
  }

  const WEBHOOK_DATA_ID = 'onshape_ts_client_webhook_sample';
  const webhooksResponse = await apiClient.get(webhookFindUri) as ListResponse<WebHookInfo>;
  LOG.trace('Webhooks response', webhooksResponse);
  const oldWebhooks = webhooksResponse?.items || [];
  terminationHandler.apiClient = apiClient;
  terminationHandler.deleteInstalledWebhooks(oldWebhooks.filter(w => w.data === WEBHOOK_DATA_ID).map(w => w.id));

  const webhookJson: WebHookParams = {
    url: webhookListenURL,
    data: WEBHOOK_DATA_ID,
    options: {
      'collapseEvents': false
    },
    events: [
      'onshape.revision.created', // Fired for every revision created
      'onshape.model.lifecycle.createversion', // Fired for every new version saved
      'onshape.model.translation.complete' // Fired when translations are completed
    ]
  };

  if (companyInfo.admin) {
    // Only company admins can listen to company level events
    webhookJson.companyId = companyInfo.id;
    // Only company admin can listen to all workflow transitions
    webhookJson.events.push('onshape.workflow.transition');
  } else {
    const documentId: string = ArgumentParser.get('documentId');
    if (!documentId) {
      throw new Error('--documentId needs to be specified for non admin company users');
    }
    webhookJson.documentId = documentId;
  }

  LOG.info('Webhook post param', webhookJson);
  const registerResponse = await apiClient.post('api/webhooks', webhookJson) as WebHookInfo;
  LOG.info('Webhook registration response', registerResponse);
  terminationHandler.createdWebhooks.push(registerResponse.id);
}

try {
  const stackToUse: string = ArgumentParser.get('stack');
  apiClient = await ApiClient.createApiClient(stackToUse);
  translationHelper = new TranslationHelper(apiClient);
  await registerWebhook(apiClient);
} catch (error) {
  console.error(error);
  LOG.error('webhook processing failed', error);
}
