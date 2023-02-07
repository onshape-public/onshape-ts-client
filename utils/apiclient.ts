import randomstring from 'randomstring';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import { constants } from 'fs';
import unirest from 'unirest';
import { IUniResponse, IUniRest } from 'unirest';
import { mainLog } from './logger.js';
import { ArgumentParser } from './argumentparser.js';
import { CompanyInfo, ListResponse } from './onshapetypes.js';

const LOG = mainLog();

interface StackCredential {
  url: string;
  companyId?: string;
  accessKey: string;
  secretKey: string;
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
    return allCompanies[0];
  }

  public async post(apiRelativePath: string, bodyData: unknown): Promise<unknown> {
    await this.avoidApiLimit();
    return await this.callApiVerb(apiRelativePath, 'POST', bodyData);
  }

  public async get(apiRelativePath: string): Promise<unknown> {
    await this.avoidApiLimit();
    return await this.callApiVerb(apiRelativePath, 'GET');
  }

  public async delete(apiRelativePath: string): Promise<unknown> {
    await this.avoidApiLimit();
    return await this.callApiVerb(apiRelativePath, 'DELETE');
  }

  public async downloadFile(apiRelativePath: string, filePath: string) {
    await this.avoidApiLimit();
    const self = this;
    const fullUri = apiRelativePath.startsWith('http') ? apiRelativePath : self.baseURL + apiRelativePath;
    return new Promise(function (resolve, reject) {
      LOG.debug(`Downloading ${fullUri} to ${filePath}`);
      const downloadreq = self.getSignedUnirest(fullUri, 'GET');
      downloadreq
        .encoding('binary')
        .timeout(600000)
        .end(function (response: IUniResponse) {
          if (self.isStatusCodeBad(response.statusCode)) {
            reject(new Error('Failed with status code ' + response.statusCode));
          } else {
            fs.writeFile(filePath, response.raw_body, 'binary');
            resolve('done');
          }
        });
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

  private isStatusCodeBad(statusCode: number): boolean {
    return statusCode >= 300 || statusCode <= 100;
  }

  private async callApiVerb(apiRelativePath: string, verb: string, bodyData?: unknown): Promise<unknown> {
    const self = this;
    const fullUri = apiRelativePath.startsWith('http') ? apiRelativePath : new URL(apiRelativePath, this.baseURL).toString();
    LOG.info(`Calling ${verb} ${fullUri}`);
    return new Promise(function (resolve, reject) {
      const lunitest = self.getSignedUnirest(fullUri, verb);
      if (bodyData) {
        lunitest
          .send(bodyData)
          .timeout(600000);
      }

      lunitest.end(function (response: IUniResponse) {
        if (self.isStatusCodeBad(response.statusCode) || response.error) {
          const errorJson = {
            statusCode: response.statusCode || 'UNKNOWN_STATUS_CODE',
            body: response.body || 'NO_BODY',
          };
          LOG.error(`${fullUri} failed`, errorJson);
          reject(errorJson);
        } else {
          resolve(response.body);
        }
      });
    });
  }

  private async avoidApiLimit(): Promise<boolean> {
    return new Promise((resolve) => setTimeout(resolve, 200));
  }

  private getSignedUnirest(fullUri: string, method: string, contentType?: string) {
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

    let lunitest: IUniRest = unirest as IUniRest;
    if ('GET' === method) {
      lunitest = lunitest.get(fullUri);
    } else if ('POST' === method) {
      lunitest = lunitest.post(fullUri);
    } else if ('PATCH' === method) {
      lunitest = lunitest.patch(fullUri);
    } else if ('HEAD' === method) {
      lunitest = lunitest.head(fullUri);
    } else if ('PUT' === method) {
      lunitest = lunitest.put(fullUri);
    } else if ('DELETE' === method) {
      lunitest = lunitest.delete(fullUri);
    }
    lunitest.header('Content-Type', contentType);
    lunitest.header('On-Nonce', onNonce);
    lunitest.header('Date', authDate);
    lunitest.header('Authorization', asign);
    lunitest.header('Accept', 'application/vnd.onshape.v2+json;charset=UTF-8;qs=0.2');
    return lunitest;
  }
}


