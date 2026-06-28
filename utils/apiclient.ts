import randomstring from 'randomstring';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import { constants } from 'fs';
import { mainLog } from './logger.js';
import { ArgumentParser } from './argumentparser.js';
import { CompanyInfo, ListResponse } from './onshapetypes.js';
import { getLogName } from './fileutils.js';

const LOG = mainLog();

interface StackCredential {
  url: string;
  companyId?: string;
  accessKey: string;
  secretKey: string;
}

/** Normalized HTTP response shape used internally after a fetch call. */
interface ApiResponse {
  statusCode: number;
  statusMessage: string;
  error: Error | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body?: any;
  raw_body?: Buffer;
}

/**
 * A simple Onshape API client that uses api keys to make REST calls against any onshape stack.
 */
export class ApiClient {
  private baseURL: string = null;
  private accessKey: string = null;
  private secretKey: string = null;
  private companyId: string = null;

  public static async createApiClient(stackToUse?: string): Promise<ApiClient> {
    const credentialsFilePath = './credentials.json';
    try {
      await fs.access(credentialsFilePath, constants.R_OK);
    } catch {
      throw new Error(`${credentialsFilePath} not found`);
    }

    const fileJson: string = await fs.readFile(credentialsFilePath, 'utf8') as string;
    const credentials = JSON.parse(fileJson) as { [id: string]: StackCredential; };
    let credsToUse: StackCredential = null;
    for (const [key, value] of Object.entries(credentials)) {
      if (stackToUse) {
        if (key === stackToUse) {
          credsToUse = value;
          break;
        }
      } else {
        stackToUse = key;
        credsToUse = value;
        break;
      }
    }

    if (stackToUse && !credsToUse) {
      throw new Error(`No credentials for "${stackToUse}" in "${credentialsFilePath}"`);
    }

    credsToUse.url = credsToUse.url || 'https://cad.onshape.com/';
    if (!credsToUse.url.match(/^http/)) {
      throw new Error(`url ${credsToUse.url} is invalid`);
    }

    LOG.info(`Creating api client against stack=${stackToUse} url=${credsToUse.url}`);
    if (!credsToUse) {
      throw new Error(`No credentials for stack=${stackToUse} in ${credentialsFilePath}`);
    }

    const apiClient = new ApiClient(credsToUse.url, credsToUse.accessKey, credsToUse.secretKey);
    apiClient.companyId = credsToUse.companyId || null;
    return apiClient;
  }

  public async findCompanyInfo(): Promise<CompanyInfo> {
    const companiesResponse = await this.get('/api/companies') as ListResponse<CompanyInfo>;
    let allCompanies = companiesResponse?.items || [];
    const companyId: string = ArgumentParser.get('companyId') || this.companyId;
    if (companyId) {
      allCompanies = allCompanies.filter(c => c.id === companyId);
    }
    const companyCount = allCompanies.length;
    if (companyCount == 0) {
      throw new Error('No company membership found');
    } else if (companyCount > 1) {
      throw new Error('User is member of multiple companies. Please specify --companyId=XXXX as argument');
    }
    this.companyId = this.companyId || allCompanies[0].id;
    return allCompanies[0];
  }

  public async post(apiRelativePath: string, bodyData: unknown): Promise<unknown> {
    return await this.callApiVerb(apiRelativePath, 'POST', bodyData);
  }

  public async get(apiRelativePath: string, acceptHeader?: string): Promise<unknown> {
    return await this.callApiVerb(apiRelativePath, 'GET', null, acceptHeader);
  }

  public async delete(apiRelativePath: string): Promise<unknown> {
    return await this.callApiVerb(apiRelativePath, 'DELETE');
  }

  public async downloadFile(apiRelativePath: string, filePath: string) {
    return await this.rateLimitedCall(async () => {
      return this.downloadFileInternal(apiRelativePath, filePath);
    });
  }

  private constructor(baseURL: string, accessKey: string, secretKey: string) {
    if (!baseURL) {
      throw new Error('baseURL cannot be empty');
    }

    if (!accessKey) {
      throw new Error('accessKey cannot be empty');
    }

    if (!secretKey) {
      throw new Error('secretKey cannot be empty');
    }

    this.baseURL = baseURL;
    this.accessKey = accessKey;
    this.secretKey = secretKey;
  }

  private async callApiVerb(apiRelativePath: string, verb: string, bodyData?: unknown, acceptHeader?: string): Promise<unknown> {
    return await this.rateLimitedCall(async () => {
      return this.callApiVerbInternal(apiRelativePath, verb, bodyData, acceptHeader);
    });
  }

  private async downloadFileInternal(apiRelativePath: string, filePath: string) {
    const fullUri = apiRelativePath.startsWith('http') ? apiRelativePath : this.baseURL + apiRelativePath;
    LOG.debug(`Downloading ${fullUri} to ${filePath}`);
    const response = await this.sendRequest(fullUri, 'GET', null, null, true);
    const apiError = this.validateApiResponse(response);
    if (apiError) {
      throw apiError;
    }
    await fs.writeFile(filePath, response.raw_body);
    return 'done';
  }

  private validateApiResponse(response: ApiResponse) {
    const statusCode: number = response.statusCode;
    if ((statusCode >= 300 || statusCode <= 100) || response.error) {
      let errorMessage = `statusCode=${statusCode} `;
      if (response?.body instanceof Object) {
        if (response?.body?.message) {
          errorMessage += response?.body?.message;
        } else if (response.statusMessage) {
          errorMessage += response.statusMessage;
        }
      } else if (response.error) {
        errorMessage += response.error.message;
      }
      return new Error(errorMessage, { cause: statusCode });
    }
    return null;
  }

  private async callApiVerbInternal(apiRelativePath: string, verb: string, bodyData?: unknown, acceptHeader?: string): Promise<unknown> {
    const fullUri = apiRelativePath.startsWith('http') ? apiRelativePath : new URL(apiRelativePath, this.baseURL).toString();
    LOG.info(`Calling ${verb} ${fullUri}`);
    const response = await this.sendRequest(fullUri, verb, bodyData, acceptHeader);
    const apiError = this.validateApiResponse(response);
    if (apiError) {
      throw apiError;
    }
    return response.body;
  }

  /** Performs a signed fetch call and normalizes the result into an ApiResponse. */
  private async sendRequest(
    fullUri: string,
    method: string,
    bodyData?: unknown,
    acceptHeader?: string,
    binary = false
  ): Promise<ApiResponse> {
    const { url, headers } = this.getSignedHeaders(fullUri, method, null, acceptHeader);
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(600000),
    };
    if (bodyData) {
      init.body = JSON.stringify(bodyData);
    }

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      return { statusCode: 0, statusMessage: '', error: e as Error };
    }

    const response: ApiResponse = {
      statusCode: res.status,
      statusMessage: res.statusText,
      error: null,
    };

    if (binary) {
      response.raw_body = Buffer.from(await res.arrayBuffer());
    } else {
      const text = await res.text();
      const contentType = res.headers.get('content-type') || '';
      if (text && contentType.includes('json')) {
        try {
          response.body = JSON.parse(text);
        } catch {
          response.body = text;
        }
      } else {
        response.body = text;
      }
    }
    return response;
  }

  private getSignedHeaders(fullUri: string, method: string, contentType?: string, acceptHeader?: string): { url: string; headers: Record<string, string> } {
    const authDate = new Date().toUTCString();
    const onNonce = randomstring.generate({
      length: 25, charset: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890',
    });

    const parsedUrl = new URL(fullUri);
    const queryString = parsedUrl.searchParams.toString();
    if (queryString) {
      parsedUrl.search = '';
      fullUri = parsedUrl.toString() + '?' + queryString;
    }

    contentType = contentType || 'application/json';

    const hmacString = [
      method,
      onNonce,
      authDate,
      contentType,
      parsedUrl.pathname,
      queryString,
      ''
    ].join('\n').toLowerCase();

    const hmac = crypto.createHmac('sha256', this.secretKey);
    hmac.update(hmacString);
    const signature = hmac.digest('base64');
    const asign = 'On ' + this.accessKey + ':HmacSHA256:' + signature;

    acceptHeader = acceptHeader || 'application/vnd.onshape.v2+json;charset=UTF-8;qs=0.2';
    const scriptName = getLogName();

    /**
     * Generate unique request id per script so it is easily searchable in kibana
     *
     * requestId:osts-revisionexport* AND response:* AND role:web_load_balancer
     * can be used to search in kibana.
     */
    const requestId = randomstring.generate({ length: 24, charset: 'hex' });
    const headers: Record<string, string> = {
      'Accept': acceptHeader,
      'User-Agent': `onshape-ts-client-1.2.0/${scriptName}`,
      'Content-Type': contentType,
      'On-Nonce': onNonce,
      'Date': authDate,
      'Authorization': asign,
      'X-Request-Id': `osts-${scriptName}-${this.companyId}-${requestId}`,
    };
    return { url: fullUri, headers };
  }

  /** The status code returned by Onshape when it rate limits apis */
  private static readonly RATE_LIMITED_STATUS = 429;
  /** The status code that indicates the script should abort immediately (e.g. payment required) */
  private static readonly PAYMENT_REQUIRED_STATUS = 402;
  /** Max number of tries before attempting to retry an API */
  private static readonly MAX_ATTEMPTS = 7;

  /**
   * Exponentially back off when API starts return 429 status.
   * Starting at 5s with factor 2 over 7 attempts the total wait is
   * 5+10+20+40+80+160 = 315s (~5 minutes) before giving up.
   */
  private static readonly SLEEP_MULTIFICATION_FACTOR = 2;
  /** Initial sleep time between 429 responses. The duration is increased exponentially when errors are encountered */
  private static readonly INITIAL_SLEEP_MS = 5000;

  /** Whether we should retry an api call that returned 429 response */
  private shouldContinueAttempt(attempt: number): boolean {
    return attempt <= ApiClient.MAX_ATTEMPTS;
  }

  /** Calls an API MAX_ATTEMPTS with exponential backoff to handle Onshape 429 responses */
  private async rateLimitedCall(callbackFn: () => Promise<unknown>) {
    // Backoff state is local so it resets for every call rather than leaking across requests
    let sleepTimeMs = ApiClient.INITIAL_SLEEP_MS;
    let attempt = 1;
    while (this.shouldContinueAttempt(attempt)) {
      try {
        attempt++;
        const result = await callbackFn();
        return result;
      } catch (error) {
        const errorException = error as Error;
        if (errorException.cause === ApiClient.PAYMENT_REQUIRED_STATUS) {
          LOG.error('Received 402 lingo API limit reached. Aborting script.');
          process.exit(1);
        } else if (errorException.cause === ApiClient.RATE_LIMITED_STATUS) {
          LOG.error(`Handling error code 429 attempt=${attempt - 1} sleep=${sleepTimeMs} ms`);
          if (!this.shouldContinueAttempt(attempt)) {
            throw error;
          }
          await new Promise(r => setTimeout(r, sleepTimeMs));
          sleepTimeMs = Math.floor(sleepTimeMs * ApiClient.SLEEP_MULTIFICATION_FACTOR);
        } else {
          throw error;
        }
      }
    }
  }
}


