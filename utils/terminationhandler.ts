import ON_DEATH from 'death';
import { mainLog } from './logger.js';
import { ApiClient } from './apiclient.js';
const LOG = mainLog();

/**
 * Responsible for cleanup when script is terminated. For now unregisters webhooks
 */
class TerminationHandler {
  apiClient: ApiClient = null;
  handledTermination = false;
  createdWebhooks: string[] = [];

  async terminate(signal: unknown): Promise<void> {
    if (this.handledTermination) {
      return;
    }
    this.handledTermination = true;
    LOG.info('Received terminal signal', signal);
    await this.deleteInstalledWebhooks(this.createdWebhooks);
  }

  /** Ensure webhooks installed by the app are cleanup on process exit */
  async deleteInstalledWebhooks(webhooks: string[]): Promise<void> {
    if (this.apiClient) {
      for (const webhookId of webhooks) {
        await this.apiClient.delete(`api/webhooks/${webhookId}`);
      }
    }
  }
}

export const terminationHandler = new TerminationHandler();

ON_DEATH(async function (signal) {
  try {
    await terminationHandler.terminate(signal);
  } catch (error) {
    LOG.error('TerminalHandler error', error);
  } finally {
    process.exit(0);
  }
});
