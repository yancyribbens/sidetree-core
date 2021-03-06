import * as Base58 from 'bs58';
import BatchFile from './BatchFile';
import Multihash from './Multihash';
import Transaction from './Transaction';
import { Cas } from './Cas';
import { DidDocument } from '@decentralized-identity/did-common-typescript';
import { didDocumentUpdate } from '../tests/mocks/MockDidDocumentGenerator';
import { WriteOperation, OperationType } from './Operation';

/**
 * VersionId identifies the version of a DID document. We use the hash of the
 * operation that produces a particular version of a DID document as its versionId.
 * This usage is guaranteed to produce unique VersionId's since the operation contains
 * as one of its properties the previous VersionId. Since the operation hash is
 * just a string we alias VersionId to string.
 *
 * With this usage, the operation hash serves two roles (1) an identifier for an operation
 * (2) an identifier for the DID document produced by the operation. In the code below,
 * we always use VersionId in places where we mean (2) and an OperationHash defined below
 * when we mean (1).
 */
export type VersionId = string;

/**
 * Alias OperationHash to string - see comment above
 */
export type OperationHash = string;

/**
 * Represents the interface used by other components to update and retrieve the
 * current state of a Sidetree node. The interface exposes methods to record
 * sidetree DID state changes (create, update, delete, recover)
 * and methods to retrieve current and historical states of a DID document.
 */
export interface DidCache {
  /**
   * The transaction that was COMPLETELY processed.
   * This is mainly used by the Observer as an offset marker to fetch new set of transactions.
   */
  readonly lastProcessedTransaction?: Transaction;

  /**
   * Applies the given DID operation to the DID Cache.
   * @returns An identifier that can be used to retrieve
   * the DID document version produced by the operation
   * and to traverse the version chain using the
   * first/last/prev/next methods below. If the write
   * operation is not legitimate return undefined.
   */
  apply (operation: WriteOperation): string | undefined;

  /**
   * Rollback the state of the DidCache by removing all operations
   * with transactionNumber greater than the provided parameter value.
   * The intended use case for this method is to handle rollbacks
   * in the blockchain.
   */
  rollback (transactionNumber: number): void;

  /**
   * Resolve a did.
   */
  resolve (didUniquePortion: string): Promise<DidDocument | undefined>;

  /**
   * Returns the Did document for a given version identifier.
   */
  lookup (versionId: VersionId): Promise<DidDocument | undefined>;

  /**
   * Return the first (initial) version identifier given
   * version identifier, which is also the DID for the
   * document corresponding to the versions. Return undefined
   * if the version id or some previous version in the chain
   * is unknown.
   */
  first (versionId: VersionId): Promise<VersionId | undefined>;

  /**
   * Return the last (latest/most recent) version identifier of
   * a given version identifier. Return undefined if the version
   * identifier is unknown or some successor identifier is unknown.
   */
  last (versionId: VersionId): Promise<VersionId | undefined>;

  /**
   * Return the previous version identifier of a given DID version
   * identifier. Return undefined if no such identifier is known.
   */
  previous (versionId: VersionId): Promise<VersionId | undefined>;

  /**
   * Return the next version identifier of a given DID version
   * identifier. Return undefined if no such identifier is known.
   */
  next (versionId: VersionId): Promise<VersionId | undefined>;
}

/**
 * The timestamp of an operation. We define a linear ordering of
 * timestamps using the function earlier() below.
 * TODO: Consider consolidating this modal interface with ResolvedTransaction.
 */
interface OperationTimestamp {
  readonly blockNumber: number;
  readonly transactionNumber: number;
  readonly operationIndex: number;
}

function earlier (ts1: OperationTimestamp, ts2: OperationTimestamp): boolean {
  return ((ts1.transactionNumber < ts2.transactionNumber) ||
          (ts1.transactionNumber === ts2.transactionNumber) && (ts1.operationIndex < ts2.operationIndex));
}

/**
 * Information about a write operation relevant for the DID cache, a subset of the properties exposed by
 * WriteOperation.
 */
interface OperationInfo {
  readonly batchFileHash: string;
  readonly type: OperationType;
  readonly timestamp: OperationTimestamp;
}

/**
 * The current implementation is a main-memory implementation without any persistence. This
 * means that when a node is powered down and restarted DID operations need to be applied
 * from the beginning of time. This implementation will be extended in the future to support
 * persistence.
 */
class DidCacheImpl implements DidCache {
  /**
   * Map a versionId to the next versionId whenever one exists.
   */
  private nextVersion: Map<VersionId, VersionId> = new Map();

  /**
   * Map a operation hash to the OperationInfo which contains sufficient
   * information to reconstruct the operation.
   */
  private opHashToInfo: Map<OperationHash, OperationInfo> = new Map();

  public constructor (private readonly cas: Cas, private didMethodName: string) {

  }

  /**
   * Apply (perform) a specified DID state changing operation.
   * @returns Hash of the operation if the operation is applied successfully, undefined if the same operation was applied previously.
   */
  public apply (operation: WriteOperation): string | undefined {
    const opHash = DidCacheImpl.getHash(operation);

    // Throw errors if missing any required metadata:
    // any operation anchored in a blockchain must have this metadata.
    if (operation.blockNumber === undefined) {
      throw Error('Invalid operation: blockNumber undefined');
    }

    if (operation.transactionNumber === undefined) {
      throw Error('Invalid operation: transactionNumber undefined');
    }

    if (operation.operationIndex === undefined) {
      throw Error('Invalid operation: operationIndex undefined');
    }

    if (operation.batchFileHash === undefined) {
      throw Error('Invalid operation: batchFileHash undefined');
    }

    // TODO: lookup operation.previousOperationHash and do signature verification.

    // opInfo is operation with derivable properties projected out
    const opTimestamp: OperationTimestamp = {
      blockNumber: operation.blockNumber,
      transactionNumber: operation.transactionNumber,
      operationIndex: operation.operationIndex
    };

    const opInfo: OperationInfo = {
      batchFileHash: operation.batchFileHash,
      type: operation.type,
      timestamp: opTimestamp
    };

    // If this is a duplicate of an earlier operation, we can
    // ignore this operation. Note that we might have a previous
    // operation with the same hash, but that previous operation
    // need not be earlier in timestamp order - hence the check
    // with earlier().
    const prevOperationInfo = this.opHashToInfo.get(opHash);
    if (prevOperationInfo !== undefined && earlier(prevOperationInfo.timestamp, opInfo.timestamp)) {
      return undefined;
    }
    // Update our mapping of operation hash to operation info overwriting
    // previous info if it exists
    this.opHashToInfo.set(opHash, opInfo);

    // For operations that have a previous version, we need additional
    // bookkeeping
    if (operation.previousOperationHash) {
      this.applyVersionChainUpdates(opHash, opInfo, operation.previousOperationHash);
    }

    return opHash;
  }

  /**
   * Rollback the state of the DidCache by removing all operations
   * with transactionNumber greater than or equal to the provided transaction number.
   * The intended use case for this method is to handle rollbacks
   * in the blockchain.
   *
   * The current implementation is inefficient: It simply scans the two
   * hashmaps storing the core Did state and removes all entries with
   * a greater transaction number.  In future, the implementation should be optimized
   * for the common case by keeping a sliding window of recent operations.
   */
  public rollback (transactionNumber: number) {

    // Iterate over all nextVersion entries and remove all versions
    // with "next" operation with transactionNumber greater than the provided
    // parameter.
    this.nextVersion.forEach((version, nextVersion, map) => {
      const opInfo = this.opHashToInfo.get(nextVersion) as OperationInfo; // version and opHash as identical concepts
      if (opInfo.timestamp.transactionNumber >= transactionNumber) {
        map.delete(version);
      }
    });

    // Iterate over all operations and remove those with with
    // transactionNumber greater than the provided parameter.
    this.opHashToInfo.forEach((opInfo, opHash, map) => {
      if (opInfo.timestamp.transactionNumber >= transactionNumber) {
        map.delete(opHash);
      }
    });
  }

  /**
   * Resolve a DID.
   * @param didUniquePortion The unique portion of the DID. e.g. did:sidetree:abc123 -> abc123.
   */
  public async resolve (didUniquePortion: string): Promise<DidDocument | undefined> {
    const latestVersion = await this.last(didUniquePortion);

    // lastVersion === undefined implies we do not know about the did
    if (latestVersion === undefined) {
      return undefined;
    }

    return this.lookup(latestVersion);
  }

  /**
   * Returns the Did document for a given version identifier.
   */
  public async lookup (versionId: VersionId): Promise<DidDocument | undefined> {
    // Version id is also the operation hash that produces the document
    const opHash = versionId;

    const opInfo = this.opHashToInfo.get(opHash);

    // We don't know anything about this operation
    if (opInfo === undefined) {
      return undefined;
    }

    // Construct the operation using a CAS lookup
    const op = await this.getOperation(opInfo);

    if (this.isInitialVersion(opInfo)) {
      return WriteOperation.toDidDocument(op, this.didMethodName);
    } else {
      const prevVersion = op.previousOperationHash as VersionId;
      const prevDidDoc = await this.lookup(prevVersion);
      if (prevDidDoc === undefined) {
        return undefined;
      } else {
        return didDocumentUpdate(prevDidDoc, op);
      }
    }
  }

  /**
   * Return the previous version id of a given DID version. The implementation
   * is inefficient and involves an async cas read. This should not be a problem
   * since this method is not hit for any of the externally exposed DID operations.
   */
  public async previous (versionId: VersionId): Promise<VersionId | undefined> {
    const opInfo = this.opHashToInfo.get(versionId);
    if (opInfo) {
      const op = await this.getOperation(opInfo);
      if (op.previousOperationHash) {
        return op.previousOperationHash;
      }
    }
    return undefined;
  }

  /**
   * Return the first version of a DID document given a possibly later version.
   * A simple recursive implementation using prev; not very efficient but should
   * not matter since this method is not hit for any externally exposed DID
   * operations.
   */
  public async first (versionId: VersionId): Promise<VersionId | undefined> {
    const opInfo = this.opHashToInfo.get(versionId);
    if (opInfo === undefined) {
      return undefined;
    }

    while (true) {
      const prevVersionId = await this.previous(versionId);
      if (prevVersionId === undefined) {
        return versionId;
      }

      versionId = prevVersionId;
    }
  }

  /**
   * Return the next version of a DID document if it exists or undefined otherwise.
   */
  public async next (versionId: VersionId): Promise<VersionId | undefined> {
    const nextVersionId = this.nextVersion.get(versionId);
    if (nextVersionId === undefined) {
      return undefined;
    } else {
      return nextVersionId;
    }
  }

  /**
   * Returns the latest (most recent) version of a DID Document.
   * Returns undefined if the version is unknown.
   */
  public async last (versionId: VersionId): Promise<VersionId | undefined> {

    const opInfo = this.opHashToInfo.get(versionId);
    if (opInfo === undefined) {
      return undefined;
    }

    while (true) {
      const nextVersionId = await this.next(versionId);
      if (nextVersionId === undefined) {
        return versionId;
      } else {
        versionId = nextVersionId;
      }
    }
  }

  /**
   * Get the last processed transaction.
   * TODO: fix this after discussing the intended semantics.
   */
  public get lastProcessedTransaction (): Transaction | undefined {
    return undefined;
  }

  /**
   * Get a cryptographic hash of the write operation.
   * In the case of a Create operation, the hash is calculated against the initial encoded create payload (DID Document),
   * for all other cases, the hash is calculated against the entire opeartion buffer.
   */
  private static getHash (operation: WriteOperation): OperationHash {
    // TODO: Can't hardcode hashing algorithm. Need to depend on protocol version.
    const sha256HashCode = 18;

    let contentBuffer;
    if (operation.type === OperationType.Create) {
      contentBuffer = Buffer.from(operation.encodedPayload);
    } else {
      contentBuffer = operation.operationBuffer;
    }

    const multihash = Multihash.hash(contentBuffer, sha256HashCode);
    const multihashBase58 = Base58.encode(multihash);
    return multihashBase58;
  }

  /**
   * Apply version chain updates for operations that have a previous version (update, delete, recover)
   */
  private applyVersionChainUpdates (opHash: OperationHash, opInfo: OperationInfo, prevVersionId: VersionId): void {
    // We might already know of an update to prevVersionId. If so, we retain
    // the older of previously known update and the current one
    const curUpdateToPrevVersionId = this.nextVersion.get(prevVersionId);
    if (curUpdateToPrevVersionId !== undefined) {
      const curUpdateToPrevVersionIdInfo = this.opHashToInfo.get(curUpdateToPrevVersionId) as OperationInfo;
      if (earlier(curUpdateToPrevVersionIdInfo.timestamp, opInfo.timestamp)) {
        return;
      }
    }

    this.nextVersion.set(prevVersionId, opHash);
  }

  /**
   * Return true if the provided operation is an initial version i.e.,
   * produced by a create operation.
   */
  private isInitialVersion (opInfo: OperationInfo): boolean {
    return opInfo.type === OperationType.Create;
  }

  /**
   * Return the operation given its (access) info.
   */
  private async getOperation (opInfo: OperationInfo): Promise<WriteOperation> {
    const batchBuffer = await this.cas.read(opInfo.batchFileHash);
    const batchFile = BatchFile.fromBuffer(batchBuffer);
    const operationBuffer = batchFile.getOperationBuffer(opInfo.timestamp.operationIndex);
    const resolvedTransaction = {
      blockNumber: opInfo.timestamp.blockNumber,
      transactionNumber: opInfo.timestamp.transactionNumber,
      anchorFileHash: 'TODO', // TODO: Will be used for detecting blockchain forks.
      batchFileHash: opInfo.batchFileHash
    };

    return WriteOperation.create(
      operationBuffer,
      resolvedTransaction,
      opInfo.timestamp.operationIndex);
  }
}

/**
 * Factory function for creating a Did cache
 */
export function createDidCache (cas: Cas, didMethodName: string): DidCache {
  return new DidCacheImpl(cas, didMethodName);
}
