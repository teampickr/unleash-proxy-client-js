import { TinyEmitter } from 'tiny-emitter';
import Metrics from './metrics';
import IStorageProvider from './storage-provider';
import AsyncStorageProvider from './storage-provider-async';

export interface IConfig {
  url: string;
  clientKey: string;
  appName: string;
  environment?: string;
  refreshInterval?: number;
  metricsInterval?: number;
  disableMetrics?: boolean;
  storageProvider?: IStorageProvider;
}

export interface IContext {
  [key: string]: string;
}

export interface IVariant {
  name: string;
  payload?: {
    type: string;
    value: string;
  };
}

export interface IToggle {
  name: string;
  enabled: boolean;
  variant: IVariant;
}

export const EVENTS = {
  READY: 'ready',
  UPDATE: 'update',
};

const defaultVariant: IVariant = { name: 'disabled' };
const storeKey = 'repo';

export class UnleashClient extends TinyEmitter {
  public toggles: IToggle[] = [];
  private context: IContext;
  private timerRef?: any;
  private storage: IStorageProvider;
  private refreshInterval: number;
  // @ts-ignore
  private url: URL;
  private clientKey: string;
  private etag: string = '';
  private metrics: Metrics;

  constructor({
    storageProvider,
    url,
    clientKey,
    refreshInterval = 30,
    metricsInterval = 30,
    disableMetrics = false,
    environment = 'default',
    appName,
  }: IConfig) {
    super();
    // Validations
    if (!url) {
      throw new Error('url is required');
    }
    if (!clientKey) {
      throw new Error('clientKey is required');
    }
    if (!appName) {
      throw new Error('appName is required.');
    }

    // @ts-ignore
    this.url = new URL(`${url}`);
    this.clientKey = clientKey;
    this.storage = storageProvider || new AsyncStorageProvider();
    this.refreshInterval = refreshInterval * 1000;
    this.context = { environment, appName };
    this.toggles = [];
    this.metrics = new Metrics({
      appName,
      metricsInterval,
      disableMetrics,
      url,
      clientKey,
    });
  }

  public async setup() {
    this.toggles = (await this.storage.get(storeKey)) || [];
  }

  public isEnabled(toggleName: string): boolean {
    const toggle = this.toggles.find((t) => t.name === toggleName);
    const enabled = toggle ? toggle.enabled : false;
    this.metrics.count(toggleName, enabled);
    return enabled;
  }

  public getVariant(toggleName: string): IVariant {
    const toggle = this.toggles.find((t) => t.name === toggleName);
    if (toggle) {
      this.metrics.count(toggleName, true);
      return toggle.variant;
    } else {
      this.metrics.count(toggleName, false);
      return defaultVariant;
    }
  }

  public removeContext(keys: string[]) {
    keys.forEach((key) => {
      if (typeof this.context[key] !== 'undefined') {
        delete this.context[key];
      }
    });
    if (this.timerRef) {
      this.fetchToggles();
    }
  }

  public updateContext(context: IContext) {
    this.context = { ...this.context, ...context };
    if (this.timerRef) {
      this.fetchToggles();
    }
  }

  public addContext(key: string, value: string) {
    this.context[key] = value;
    if (this.timerRef) {
      this.fetchToggles();
    }
  }

  public async start(): Promise<void> {
    this.stop();
    const interval = this.refreshInterval;
    await this.fetchToggles();
    this.emit(EVENTS.READY);
    this.timerRef = setInterval(() => this.fetchToggles(), interval);
  }

  public stop(): void {
    if (this.timerRef) {
      clearInterval(this.timerRef);
      this.timerRef = undefined;
    }
  }

  private async storeToggles(toggles: IToggle[]): Promise<void> {
    this.toggles = toggles;
    this.emit(EVENTS.UPDATE);
    await this.storage.save(storeKey, toggles);
  }

  private async fetchToggles() {
    try {
      const context = this.context;
      // @ts-ignore
      const urlWithQuery = new URL(this.url.toString());
      Object.keys(context).forEach((key) =>
        urlWithQuery.searchParams.append(key, context[key]),
      );
      const response = await fetch(urlWithQuery.toString(), {
        headers: {
          'Authorization': this.clientKey,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'If-None-Match': this.etag,
        },
      });
      if (response.ok && response.status !== 304) {
        this.etag = response.headers.get('ETag') || '';
        const data = await response.json();
        await this.storeToggles(data.toggles);
      }
    } catch (e) {
      // tslint:disable-next-line
      console.error('Unleash: unable to fetch feature toggles', e);
    }
  }
}
