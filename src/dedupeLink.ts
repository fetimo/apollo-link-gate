import { ApolloLink, Operation, FetchResult, NextLink } from '@apollo/client/link/core';
import { Observable, Observer } from '@apollo/client/utilities';
import { ApolloClient, NormalizedCacheObject } from '@apollo/client';
import { extractKey } from './extractKey';

interface OperationQueueEntry {
  optimisticResponse: any;
  operation: Operation;
  forward: NextLink;
  observer: Observer<FetchResult>;
  subscription?: { unsubscribe: () => void };
}

const hasStorage = typeof localStorage !== 'undefined';

const STORAGE_KEY = 'ald-ops';
const OPEN_STORAGE_KEY = 'ald-on';

export default class DedupeLink extends ApolloLink {
  private opQueue: { [key: string]: OperationQueueEntry } = {};

  private isOpen = !hasStorage ? true : sessionStorage.getItem(OPEN_STORAGE_KEY) !== '0';

  private client: ApolloClient<NormalizedCacheObject>;

  private constructor(config) {
    super();

    this.client = config.client;
    this.rehydrateQueue();
  }

  private rehydrateQueue() {
    // If localStorage is available then we get the previously queued items.
    if (hasStorage) {
      const previouslyStoredString = localStorage.getItem(STORAGE_KEY);

      if (previouslyStoredString) {
        // Requeue queries by calling mutate. This is why we need the client to be passed in.
        const opQueue: { [key: string]: OperationQueueEntry } = JSON.parse(previouslyStoredString);
        Promise.all(
          Object.keys(opQueue).map(async (key) => {
            // eslint-disable-next-line security/detect-object-injection
            const entry = opQueue[key];
            return this.client.mutate({
              optimisticResponse: entry.optimisticResponse,
              mutation: entry.operation.query,
              variables: entry.operation.variables,
            });
          })
        )
          .then(() => {
            // Once they're done remove the old mutations.
            localStorage.removeItem(STORAGE_KEY);
          })
          .catch((error) => {
            // eslint-disable-next-line no-console
            console.log('DedupeLink: Could not process stored mutations because of', error);
          });
      }
    }
  }

  public open() {
    this.isOpen = true;
    if (hasStorage) {
      sessionStorage.setItem(OPEN_STORAGE_KEY, '1');
      this.rehydrateQueue();
    }

    Object.keys(this.opQueue).forEach((key) => {
      // eslint-disable-next-line security/detect-object-injection
      const { operation, forward, observer } = this.opQueue[key];
      forward(operation).subscribe(observer);
    });
    this.opQueue = {};
  }

  public close() {
    this.isOpen = false;
    if (hasStorage) {
      sessionStorage.setItem(OPEN_STORAGE_KEY, '0');
    }
  }

  public request(origOperation: Operation, forward: NextLink) {
    const { operation, key } = extractKey(origOperation);
    if (!key) {
      return forward(operation);
    }

    if (this.isOpen) {
      return forward(operation);
    }

    const context = operation.getContext();
    if (context.skipQueue) {
      return forward(operation);
    }

    return new Observable<FetchResult>((observer: Observer<FetchResult>) => {
      const operationEntry = {
        operation,
        forward,
        observer,
        optimisticResponse: context.optimisticResponse,
      };
      this.enqueue(key, operationEntry);
      return () => this.cancelOperation(key);
    });
  }

  private cancelOperation(key) {
    // eslint-disable-next-line security/detect-object-injection
    delete this.opQueue[key];
    if (hasStorage) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.opQueue));
    }
  }

  private enqueue(key, entry: OperationQueueEntry) {
    // eslint-disable-next-line security/detect-object-injection
    this.opQueue[key] = entry;
    if (hasStorage) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.opQueue));
    }
  }
}
