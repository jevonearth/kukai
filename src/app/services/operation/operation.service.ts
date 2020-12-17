import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { of, Observable, from as fromPromise } from 'rxjs';
import { catchError, flatMap, timeout } from 'rxjs/operators';
import { Buffer } from 'buffer';
import * as libs from 'libsodium-wrappers';
import * as Bs58check from 'bs58check';
import * as bip39 from 'bip39';
import Big from 'big.js';
import { localForger } from '@taquito/local-forging';
import { TranslateService } from '@ngx-translate/core';
import { CONSTANTS } from '../../../environments/environment';
import { ErrorHandlingPipe } from '../../pipes/error-handling.pipe';
import * as elliptic from 'elliptic';
import { instantiateSecp256k1, hexToBin, binToHex } from '@bitauth/libauth';
import { TokenService } from '../token/token.service';
import { isEqual } from 'lodash';

const httpOptions = { headers: { 'Content-Type': 'application/json' } };

export interface KeyPair {
  sk: string | null;
  pk: string | null;
  pkh: string;
}
@Injectable()
export class OperationService {
  nodeURL = CONSTANTS.NODE_URL;
  prefix = {
    tz1: new Uint8Array([6, 161, 159]),
    tz2: new Uint8Array([6, 161, 161]),
    tz3: new Uint8Array([6, 161, 164]),
    edpk: new Uint8Array([13, 15, 37, 217]),
    sppk: new Uint8Array([3, 254, 226, 86]),
    edsk: new Uint8Array([43, 246, 78, 7]),
    spsk: new Uint8Array([17, 162, 224, 201]),
    edsig: new Uint8Array([9, 245, 205, 134, 18]),
    spsig: new Uint8Array([13, 115, 101, 19, 63]),
    sig: new Uint8Array([4, 130, 43]),
    o: new Uint8Array([5, 116]),
    B: new Uint8Array([1, 52]),
    TZ: new Uint8Array([3, 99, 29]),
    KT: new Uint8Array([2, 90, 121])
  };
  microTez = new Big(1000000);
  feeHardCap = 10; //tez
  constructor(
    private http: HttpClient,
    private translate: TranslateService,
    private errorHandlingPipe: ErrorHandlingPipe,
    private tokenService: TokenService
  ) { }
  /*
    Returns an observable for the activation of an ICO identity
  */
  activate(pkh: string, secret: string): Observable<any> {
    return this.getHeader()
      .pipe(flatMap((header: any) => {
        const fop: any = {
          branch: header.hash,
          contents: [{
            kind: 'activate_account',
            pkh: pkh,
            secret: secret
          }]
        };
        return this.http.post(this.nodeURL + '/chains/main/blocks/head/helpers/forge/operations', fop)
          .pipe(flatMap((opbytes: any) => {
            const sopbytes: string = opbytes + Array(129).join('0');
            fop.protocol = header.protocol;
            fop.signature = 'edsigtXomBKi5CTRf5cjATJWSyaRvhfYNHqSUGrn4SdbYRcGwQrUGjzEfQDTuqHhuA8b2d8NarZjz8TRf65WkpQmo423BtomS8Q';
            return this.http.post(this.nodeURL + '/chains/main/blocks/head/helpers/preapply/operations', [fop])
              .pipe(flatMap((preApplyResult: any) => {
                console.log(JSON.stringify(preApplyResult));
                return this.http.post(this.nodeURL + '/injection/operation',
                  JSON.stringify(sopbytes), httpOptions)
                  .pipe(flatMap((final: any) => {
                    return this.opCheck(final);
                  }));
              }));
          }));
      })).pipe(catchError(err => this.errHandler(err)));
  }
  opCheck(final: any, newPkh: string = null): Observable<any> {
    if (typeof (final) === 'string' && final.length === 51) {
      return of(
        {
          success: true,
          payload: {
            opHash: final,
            newPkh: newPkh
          }
        });
    } else {
      return of(
        {
          success: false,
          payload: {
            opHash: null,
            msg: final
          }
        });
    }
  }
  /*
    Returns an observable for the origination of new accounts.
  */
  originate(pkh: string, amount: number, fee: number = 0, keys: KeyPair): Observable<any> {
    return this.getHeader()
      .pipe(flatMap((header: any) => {
        return this.http.get(this.nodeURL + '/chains/main/blocks/head/context/contracts/' + keys.pkh + '/counter', {})
          .pipe(flatMap((actions: number) => {
            return this.http.get(this.nodeURL + '/chains/main/blocks/head/context/contracts/' + keys.pkh + '/manager_key', {})
              .pipe(flatMap((manager: any) => {
                if (fee >= this.feeHardCap) {
                  throw new Error('TooHighFee');
                }
                let counter: number = Number(actions);
                const script = this.getManagerScript(keys.pkh);
                const fop: any = {
                  branch: header.hash,
                  contents: [
                    {
                      kind: 'origination',
                      source: keys.pkh,
                      fee: this.microTez.times(fee).toString(),
                      counter: (++counter).toString(),
                      gas_limit: '15678',
                      storage_limit: '509',
                      balance: this.microTez.times(amount).toString(),
                      script: script
                    }
                  ]
                };
                if (manager === null) {
                  fop.contents[1] = fop.contents[0];
                  fop.contents[0] = {
                    kind: 'reveal',
                    source: keys.pkh,
                    fee: '0',
                    counter: (counter).toString(),
                    gas_limit: '1000',
                    storage_limit: '0',
                    public_key: keys.pk
                  };
                  fop.contents[1].counter = (Number(fop.contents[1].counter) + 1).toString();
                }
                return this.operation(fop, header, keys, true);
              }));
          }));
      })).pipe(catchError(err => this.errHandler(err)));
  }
  /*
    Returns an observable for the transaction of tez.
  */
  transfer(from: string, transactions: any, fee: number, keys: KeyPair, tokenTransfer: string = ''): Observable<any> {
    return this.getHeader()
      .pipe(flatMap((header: any) => {
        return this.http.get(this.nodeURL + '/chains/main/blocks/head/context/contracts/' + keys.pkh + '/counter', {})
          .pipe(flatMap((actions: any) => {
            return this.http.get(this.nodeURL + '/chains/main/blocks/head/context/contracts/' + keys.pkh + '/manager_key', {})
              .pipe(flatMap((manager: any) => {
                if (fee >= this.feeHardCap) {
                  throw new Error('TooHighFee');
                }
                const counter: number = Number(actions);
                const fop = this.createTransactionObject(header.hash, counter, manager, transactions, keys.pkh, keys.pk, from, fee, tokenTransfer);
                return this.operation(fop, header, keys);
              }));
          }));
      })).pipe(catchError(err => this.errHandler(err)));
  }
  createTransactionObject(hash: string, counter: number, manager: string, transactions: any,
    pkh: string, pk: string, from: string, fee: number, tokenTransfer: string): any {
    const fop: any = {
      branch: hash,
      contents: []
    };
    if (manager === null) { // Reveal
      fop.contents.push({
        kind: 'reveal',
        source: pkh,
        fee: '0',
        counter: (++counter).toString(),
        gas_limit: '1000',
        storage_limit: '0',
        public_key: pk
      });
    }
    for (let i = 0; i < transactions.length; i++) {
      const currentFee = i === transactions.length - 1 ? this.microTez.times(fee).toString() : '0';
      const gasLimit = transactions[i].gasLimit.toString();
      const storageLimit = transactions[i].storageLimit.toString();
      if (tokenTransfer) {
        console.log('Invoke contract: ' + tokenTransfer);
        let invocation: any;
        const { kind, decimals, contractAddress, id } = this.tokenService.getAsset(tokenTransfer);
        if (kind === 'FA1.2') {
          invocation = this.getFA12Transaction(pkh, transactions[i].to, Big(10 ** decimals).times(transactions[i].amount).toString());
        } else if (kind === 'FA2') {
          invocation = this.getFA2Transaction(pkh, transactions[i].to, Big(10 ** decimals).times(transactions[i].amount).toString(), id);
        } else {
          throw new Error('Unrecognized token kind');
        }
        fop.contents.push({
          kind: 'transaction',
          source: pkh,
          fee: currentFee,
          counter: (++counter).toString(),
          gas_limit: gasLimit,
          storage_limit: storageLimit,
          amount: '0',
          destination: contractAddress,
          parameters: invocation
        });
      } else if (from.slice(0, 2) === 'tz') {
        const transactionOp: any = {
          kind: 'transaction',
          source: from,
          fee: currentFee,
          counter: (++counter).toString(),
          gas_limit: gasLimit,
          storage_limit: storageLimit,
          amount: this.microTez.times(transactions[i].amount).toString(),
          destination: transactions[i].to,
        };
        if (transactions.length === 1 && transactions[i].parameters) {
          transactionOp.parameters = transactions[i].parameters;
        }
        fop.contents.push(transactionOp);
      } else if (from.slice(0, 2) === 'KT') {
        if (transactions[i].to.slice(0, 2) === 'tz') {
          const managerTransaction = this.getContractPkhTransaction(transactions[i].to, this.microTez.times(transactions[i].amount).toString());
          fop.contents.push({
            kind: 'transaction',
            source: pkh,
            fee: currentFee,
            counter: (++counter).toString(),
            gas_limit: gasLimit,
            storage_limit: storageLimit,
            amount: '0',
            destination: from,
            parameters: managerTransaction
          });
        } else if (transactions[i].to.slice(0, 2) === 'KT') {
          const managerTransaction = this.getContractKtTransaction(transactions[i].to, this.microTez.times(transactions[i].amount).toString());
          fop.contents.push({
            kind: 'transaction',
            source: pkh,
            fee: currentFee,
            counter: (++counter).toString(),
            gas_limit: gasLimit,
            storage_limit: storageLimit,
            amount: '0',
            destination: from,
            parameters: managerTransaction
          });
        }
      }
    }
    return fop;
  }
  /*
    Returns an observable for the delegation of baking rights.
  */
  delegate(from: string, to: string, fee: number = 0, keys: KeyPair): Observable<any> {
    return this.getHeader()
      .pipe(flatMap((header: any) => {
        return this.http.get(this.nodeURL + '/chains/main/blocks/head/context/contracts/' + keys.pkh + '/counter', {})
          .pipe(flatMap((actions: any) => {
            return this.http.get(this.nodeURL + '/chains/main/blocks/head/context/contracts/' + keys.pkh + '/manager_key', {})
              .pipe(flatMap((manager: any) => {
                if (fee >= this.feeHardCap) {
                  throw new Error('TooHighFee');
                }
                let counter: number = Number(actions);
                let delegationOp: any;
                if (from.slice(0, 2) === 'tz') {
                  delegationOp = {
                    kind: 'delegation',
                    source: from,
                    fee: this.microTez.times(fee).toString(),
                    counter: (++counter).toString(),
                    gas_limit: '1000',
                    storage_limit: '0',
                  };
                  if (to !== '') {
                    delegationOp.delegate = to;
                  }
                } else if (from.slice(0, 2) === 'KT') {
                  delegationOp = {
                    kind: 'transaction',
                    source: keys.pkh,
                    fee: this.microTez.times(fee).toString(),
                    counter: (++counter).toString(),
                    gas_limit: '4380',
                    storage_limit: '0',
                    amount: '0',
                    destination: from,
                    parameters: (to !== '') ? this.getContractDelegation(to) : this.getContractUnDelegation()
                  };
                }
                const fop: any = {
                  branch: header.hash,
                  contents: [
                    delegationOp
                  ]
                };
                if (manager === null) {
                  fop.contents[1] = fop.contents[0];
                  fop.contents[0] = {
                    kind: 'reveal',
                    source: keys.pkh,
                    fee: '0',
                    counter: (counter).toString(),
                    gas_limit: '1000',
                    storage_limit: '0',
                    public_key: keys.pk
                  };
                  fop.contents[1].counter = (Number(fop.contents[1].counter) + 1).toString();
                }
                return this.operation(fop, header, keys);
              }));
          }));
      })).pipe(catchError(err => this.errHandler(err)));
  }
  /*
  Help function for operations
  */
  operation(fop: any, header: any, keys: KeyPair, origination: boolean = false): Observable<any> {
    console.log('fop to send: ' + JSON.stringify(fop));
    return this.http.post(this.nodeURL + '/chains/main/blocks/head/helpers/forge/operations', fop)
      .pipe(flatMap((opbytes: any) => {
        return this.localForge(fop)
          .pipe(flatMap((localOpbytes: string) => {
            if (opbytes !== localOpbytes) {
              throw new Error('ValidationError');
            }
            if (!keys.sk) {
              fop.signature = 'edsigtXomBKi5CTRf5cjATJWSyaRvhfYNHqSUGrn4SdbYRcGwQrUGjzEfQDTuqHhuA8b2d8NarZjz8TRf65WkpQmo423BtomS8Q';
              return this.http.post(this.nodeURL + '/chains/main/blocks/head/helpers/scripts/run_operation', { operation: fop, chain_id: header.chain_id })
                .pipe(flatMap((applied: any) => {
                  console.log('applied: ' + JSON.stringify(applied));
                  this.checkApplied([applied]);
                  return of(
                    {
                      success: true,
                      payload: {
                        unsignedOperation: opbytes
                      }
                    });
                }));
            } else {
              fop.protocol = header.protocol;
              const signed = this.sign(opbytes, keys.sk);
              const sopbytes = signed.sbytes;
              fop.signature = signed.edsig;
              return this.http.post(this.nodeURL + '/chains/main/blocks/head/helpers/preapply/operations', [fop])
                .pipe(flatMap((applied: any) => {
                  console.log('applied: ' + JSON.stringify(applied));
                  this.checkApplied(applied);
                  console.log('sop: ' + sopbytes);
                  return this.http.post(this.nodeURL + '/injection/operation', JSON.stringify(sopbytes), httpOptions)
                    .pipe(
                      timeout(20000)
                    )
                    .pipe(flatMap((final: any) => {
                      let newPkh = null;
                      if (origination) {
                        newPkh = applied[0].contents[fop.contents.length - 1].
                          metadata.operation_result.originated_contracts[0];
                      }
                      return this.opCheck(final, newPkh);
                    }));
                }));
            }
          }));
      }));
  }
  /*
    Broadcast a signed operation to the network
  */
  broadcast(sopbytes: string): Observable<any> {
    console.log('Broadcast...');
    const opbytes = sopbytes.slice(0, sopbytes.length - 128);
    const edsig = this.sig2edsig(sopbytes.slice(sopbytes.length - 128));
    return fromPromise(localForger.parse(opbytes)).pipe(flatMap((fop: any) => {
      fop.signature = edsig;
      return this.getHeader().pipe(flatMap((header: any) => {
        fop.protocol = header.protocol;
        return this.http.post(this.nodeURL + '/chains/main/blocks/head/helpers/preapply/operations', [fop])
          .pipe(flatMap((parsed: any) => {
            let newPkh = null;
            for (let i = 0; i < parsed[0].contents.length; i++) {
              if (parsed[0].contents[i].kind === 'origination') {
                newPkh = parsed[0].contents[i].metadata.operation_result.originated_contracts[0];
              }
            }
            return this.http.post(this.nodeURL + '/injection/operation', JSON.stringify(sopbytes), httpOptions)
              .pipe(flatMap((final: any) => {
                return this.opCheck(final, newPkh);
              }));
          }));
      }));
    })).pipe(catchError(err => this.errHandler(err)));
  }
  torusKeyLookup(tz2address: string): Observable<any> {
    // Make it into Promise
    // Zero padding
    if (tz2address.length !== 36 || tz2address.slice(0, 3) !== 'tz2') {
      throw new Error('InvalidTorusAddress');
    }
    return this.http.get(this.nodeURL + `/chains/main/blocks/head/context/contracts/${tz2address}/manager_key`, {})
      .pipe(flatMap((manager: any) => {
        if (manager === null) {
          return of({ noReveal: true });
        } else {
          return fromPromise(this.decompress(manager)).pipe(flatMap((pk: any) => {
            const torusReq = {
              jsonrpc: '2.0',
              method: 'KeyLookupRequest',
              id: 10,
              params: {
                pub_key_X: pk.X,
                pub_key_Y: pk.Y
              }
            };
            const url = CONSTANTS.NETWORK === 'mainnet' ? 'https://torus-19.torusnode.com/jrpc' : 'https://teal-15-1.torusnode.com/jrpc';
            return this.http.post(url, JSON.stringify(torusReq), httpOptions)
              .pipe(flatMap((ans: any) => {
                try {
                  if (ans.result.PublicKey.X === pk.X &&
                    ans.result.PublicKey.Y === pk.Y) {
                    return of(ans);
                  } else {
                    return of(null);
                  }
                } catch {
                  return of(null);
                }
              }));
          }));
        }
      }));
  }
  checkApplied(applied: any) {
    for (let i = 0; i < applied[0].contents.length; i++) {
      if (applied[0].contents[i].metadata.operation_result.status !== 'applied') {
        console.log('throw error ->');
        if (applied[0].contents[i].metadata.operation_result.errors) {
          console.log('Error in operation_result');
          throw applied[0].contents[i].metadata.operation_result.errors[
          applied[0].contents[i].metadata.operation_result.errors.length - 1
          ];
        } else if (applied[0].contents[i].metadata.internal_operation_results &&
          applied[0].contents[i].metadata.internal_operation_results[0].result.errors) {
          console.log('Error in internal_operation_results');
          throw applied[0].contents[i].metadata.internal_operation_results[0].result.errors[
          applied[0].contents[i].metadata.internal_operation_results[0].result.errors.length - 1
          ];
        } else {
          throw new Error('Uncatched error in preapply');
        }
      }
    }
  }
  errHandler(error: any): Observable<any> {
    console.log(JSON.stringify(error));
    if (error.error && error.error[0]) {
      error = error.error[0];
    }
    if (error.message) {
      error = this.errorHandlingPipe.transform(error.message);
    } else if (error.id) {
      if (error.with) {
        error = this.errorHandlingPipe.transform(error.id, error.with);
      } else if (error.id === 'failure' && error.msg) {
        error = this.errorHandlingPipe.transform(error.msg);
      } else {
        error = this.errorHandlingPipe.transform(error.id);
      }
    } else if (error.statusText) {
      error = error.statusText;
    } else if (typeof error === 'string') {
      error = this.errorHandlingPipe.transform(error);
    } else {
      console.warn('Error not categorized', error);
      error = 'Unrecogized error';
    }
    return of(
      {
        success: false,
        payload: {
          msg: error
        }
      }
    );
  }
  // Local forge with Taquito
  localForge(operation: any): Observable<string> {
    return fromPromise(localForger.forge(operation)).pipe(flatMap((localForgedBytes: string) => {
      return of(localForgedBytes);
    }));
  }
  getHeader(): Observable<any> {
    return this.http.get(this.nodeURL + '/chains/main/blocks/head/header');
  }
  getBalance(pkh: string): Observable<any> {
    return this.http.get(this.nodeURL + '/chains/main/blocks/head/context/contracts/' + pkh + '/balance')
      .pipe(flatMap((balance: any) => {
        return of(
          {
            success: true,
            payload: {
              balance: balance
            }
          }
        );
      })).pipe(catchError(err => this.errHandler(err)));
  }
  getDelegate(pkh: string): Observable<any> {
    return this.http.get(this.nodeURL + '/chains/main/blocks/head/context/contracts/' + pkh)
      .pipe(flatMap((contract: any) => {
        let delegate = '';
        if (contract.delegate) {
          delegate = contract.delegate;
        }
        return of(
          {
            success: true,
            payload: {
              delegate: delegate
            }
          }
        );
      })).pipe(catchError(err => this.errHandler(err)));
  }
  getVotingRights(): Observable<any> {
    return this.http.get(this.nodeURL + '/chains/main/blocks/head/votes/listings')
      .pipe(flatMap((listings: any) => {
        return of(
          {
            success: true,
            payload: listings
          }
        );
      })).pipe(catchError(err => this.errHandler(err)));
  }
  isRevealed(pkh: string): Observable<boolean> {
    return this.http.get(this.nodeURL + '/chains/main/blocks/head/context/contracts/' + pkh + '/manager_key', {})
      .pipe(flatMap((manager: any) => {
        if (manager === null) {
          return of(false);
        } else {
          return of(true);
        }
      }
      )).pipe(catchError(err => {
        return of(true);
      })); // conservative action
  }
  getAccount(pkh: string): Observable<any> {
    return this.http.get(this.nodeURL + '/chains/main/blocks/head/context/contracts/' + pkh)
      .pipe(flatMap((contract: any) => {
        let delegate = '';
        if (contract.delegate) {
          delegate = contract.delegate;
        }
        return of(
          {
            success: true,
            payload: {
              balance: contract.balance,
              manager: contract.manager,
              delegate: delegate,
              counter: contract.counter
            }
          }
        );
      })).pipe(catchError(err => this.errHandler(err)));
  }
  getVerifiedOpBytes(operationLevel, operationHash, pkh, pk): Observable<string> {
    return this.http.get(this.nodeURL + '/chains/main/blocks/' + operationLevel + '/operation_hashes', {})
      .pipe(flatMap((opHashes: any) => {
        const opIndex = opHashes[3].findIndex(a => a === operationHash);
        return this.http.get(this.nodeURL + '/chains/main/blocks/' + operationLevel + '/operations', {})
          .pipe(flatMap((op: any) => {
            let ans = '';
            op = op[3][opIndex];
            const sig = op.signature;
            delete op.chain_id;
            delete op.signature;
            delete op.hash;
            delete op.protocol;
            for (let i = 0; i < op.contents.length; i++) {
              delete op.contents[i].metadata;
              if (op.contents[i].managerPubkey) { // Fix for mainnet
                op.contents[i].manager_pubkey = op.contents[i].managerPubkey;
                delete op.contents[i].managerPubkey;
              }
            }
            return this.http.post(this.nodeURL + '/chains/main/blocks/head/helpers/forge/operations', op)
              .pipe(flatMap((opBytes: any) => {
                if (this.pk2pkh(pk) === pkh) {
                  if (this.verify(opBytes, sig, pk)) {
                    ans = opBytes + this.buf2hex(this.b58cdecode(sig, this.prefix.sig));
                  } else {
                    throw new Error('InvalidSignature');
                  }
                } else {
                  throw new Error('InvalidPublicKey');
                }
                return of(ans);
              }));
          }));
      }));
  }
  createKTaddress(sopBytes: string): string {
    const hash = libs.crypto_generichash(32, this.hex2buf(sopBytes));
    const index = new Uint8Array([0, 0, 0, 0]);
    const hash2 = libs.crypto_generichash(20, this.mergebuf(index, hash));
    return this.b58cencode(hash2, this.prefix.KT);
  }
  getConstants(): Observable<any> {
    return this.http.get(this.nodeURL + '/chains/main/blocks/head/context/constants');
  }
  seed2keyPair(seed: Buffer): KeyPair {
    if (!seed) {
      throw new Error('NullSeed');
    }
    const keyPair = libs.crypto_sign_seed_keypair(seed);
    return {
      sk: this.b58cencode(keyPair.privateKey, this.prefix.edsk),
      pk: this.b58cencode(keyPair.publicKey, this.prefix.edpk),
      pkh: this.b58cencode(libs.crypto_generichash(20, keyPair.publicKey), this.prefix.tz1)
    };
  }
  mnemonic2seed(mnemonic: string, passphrase: string = '') {
    if (!this.validMnemonic(mnemonic)) {
      throw new Error('InvalidMnemonic');
    }
    return (bip39.mnemonicToSeedSync(mnemonic, passphrase)).slice(0, 32);
  }
  mnemonic2entropy(mnemonic: string, passphrase: string = '') {
    if (!this.validMnemonic(mnemonic)) {
      throw new Error('InvalidMnemonic');
    }
    return bip39.mnemonicToEntropy(mnemonic);
  }
  validMnemonic(mnemonic: string) {
    return bip39.validateMnemonic(mnemonic);
  }
  validAddress(address: string) {
    try {
      this.b58cdecode(address, this.prefix.tz1);
      return true;
    } catch (e) {
      return false;
    }
  }
  pk2pkh(pk: string): string {
    if (pk.length === 54 && pk.slice(0, 4) === 'edpk') {
      const pkDecoded = this.b58cdecode(pk, this.prefix.edpk);
      return this.b58cencode(libs.crypto_generichash(20, pkDecoded), this.prefix.tz1);
    } else if (pk.length === 55 && pk.slice(0, 4) === 'sppk') {
      const pkDecoded = this.b58cdecode(pk, this.prefix.edpk);
      return this.b58cencode(libs.crypto_generichash(20, pkDecoded), this.prefix.tz2);
    }
    throw new Error('Invalid public key');
  }
  spPrivKeyToKeyPair(secretKey: string) {
    let sk;
    if (secretKey.match(/^[0-9a-f]{64}$/g)) {
      sk = this.b58cencode(this.hex2buf(secretKey), this.prefix.spsk);
    } else if (secretKey.match(/^spsk[1-9a-km-zA-HJ-NP-Z]{50}$/g)) {
      sk = secretKey;
    } else {
      throw new Error('Invalid private key');
    }
    const keyPair = (new elliptic.ec('secp256k1')).keyFromPrivate(
      new Uint8Array(this.b58cdecode(sk, this.prefix.spsk))
    );
    const prefixVal = keyPair.getPublic().getY().toArray()[31] % 2 ? 3 : 2; // Y odd / even
    const pad = new Array(32).fill(0); // Zero-padding
    const publicKey = new Uint8Array(
      [prefixVal].concat(pad.concat(keyPair.getPublic().getX().toArray()).slice(-32)
      ));
    const pk = this.b58cencode(publicKey, this.prefix.sppk);
    const pkh = this.pk2pkh(pk);
    return { sk, pk, pkh };
  }
  spPointsToPkh(pubX: string, pubY: string): string {
    const key = (new elliptic.ec('secp256k1')).keyFromPublic({ x: pubX, y: pubY });
    const prefixVal = key.getPublic().getY().toArray()[31] % 2 ? 3 : 2;
    const pad = new Array(32).fill(0);
    const publicKey = new Uint8Array(
      [prefixVal].concat(pad.concat(key.getPublic().getX().toArray()).slice(-32)
      ));
    const pk = this.b58cencode(publicKey, this.prefix.sppk);
    const pkh = this.pk2pkh(pk);
    return pkh;
  }
  async decompress(pk: string): Promise<any> {
    const decodedPk = this.b58cdecode(pk, this.prefix.sppk);
    const hexPk = this.buf2hex(decodedPk);
    const secp256k1 = await instantiateSecp256k1();
    const compressed = hexToBin(hexPk);
    const uncompressed = secp256k1.uncompressPublicKey(compressed);
    const xy = binToHex(uncompressed).slice(2);
    return { X: xy.slice(0, 64), Y: xy.slice(64, 128) };
  }
  hex2pk(hex: string): string {
    return this.b58cencode(this.hex2buf(hex.slice(2, 66)), this.prefix.edpk);
  }
  hex2buf(hex) {
    return new Uint8Array(hex.match(/[\da-f]{2}/gi).map(function (h) {
      return parseInt(h, 16);
    }));
  }
  buf2hex(buffer) {
    const byteArray = new Uint8Array(buffer), hexParts = [];
    for (let i = 0; i < byteArray.length; i++) {
      const hex = byteArray[i].toString(16);
      const paddedHex = ('00' + hex).slice(-2);
      hexParts.push(paddedHex);
    }
    return hexParts.join('');
  }
  b58cencode(payload: any, prefixx?: Uint8Array) {
    const n = new Uint8Array(prefixx.length + payload.length);
    n.set(prefixx);
    n.set(payload, prefixx.length);
    return Bs58check.encode(Buffer.from(this.buf2hex(n), 'hex'));
  }
  b58cdecode(enc, prefixx) {
    let n = Bs58check.decode(enc);
    n = n.slice(prefixx.length);
    return n;
  }
  mergebuf(b, wm = new Uint8Array([3])) {
    const r = new Uint8Array(wm.length + b.length);
    r.set(wm);
    r.set(b, wm.length);
    return r;
  }
  ledgerPreHash(opbytes: string): string {
    return this.buf2hex(libs.crypto_generichash(32, this.mergebuf(this.hex2buf(opbytes))));
  }
  sign(bytes, sk): any {
    if (sk.slice(0, 4) === 'spsk') {
      const hash = libs.crypto_generichash(32, this.mergebuf(this.hex2buf(bytes)));
      const key = (new elliptic.ec('secp256k1')).keyFromPrivate(new Uint8Array(this.b58cdecode(sk, this.prefix.spsk)));
      let sig = key.sign(hash, { canonical: true });
      sig = new Uint8Array(sig.r.toArray().concat(sig.s.toArray()));
      const spsig = this.b58cencode(sig, this.prefix.spsig);
      const sbytes = bytes + this.buf2hex(sig);
      return {
        bytes: bytes,
        sig: sig,
        edsig: spsig,
        sbytes: sbytes,
      };
    } else {
      const hash = libs.crypto_generichash(32, this.mergebuf(this.hex2buf(bytes)));
      const sig = libs.crypto_sign_detached(hash, this.b58cdecode(sk, this.prefix.edsk), 'uint8array');
      const edsig = this.b58cencode(sig, this.prefix.edsig);
      const sbytes = bytes + this.buf2hex(sig);
      return {
        bytes: bytes,
        sig: sig,
        edsig: edsig,
        sbytes: sbytes,
      };
    }
  }
  verify(bytes: string, sig: string, pk: string): Boolean {
    const hash = libs.crypto_generichash(32, this.mergebuf(this.hex2buf(bytes)));
    const signature = this.b58cdecode(sig, this.prefix.sig);
    const publicKey = this.b58cdecode(pk, this.prefix.edpk);
    return libs.crypto_sign_verify_detached(signature, hash, publicKey);
  }
  sig2edsig(sig: string): any {
    return this.b58cencode(this.hex2buf(sig), this.prefix.edsig);
  }
  decodeString(bytes: string): string {
    return Buffer.from(this.hex2buf(bytes)).toString('utf-8');
  }
  zarithDecode(hex: string): any {
    let count = 0;
    let value = 0;
    while (1) {
      const byte = Number('0x' + hex.slice(0 + count * 2, 2 + count * 2));
      value += ((byte & 127) * (128 ** count));
      count++;
      if ((byte & 128) !== 128) {
        break;
      }
    }
    return {
      value: value,
      count: count
    };
  }
  zarithDecodeInt(hex: string): any {
    let count = 0;
    let value = Big(0);
    while (1) {
      const byte = Number('0x' + hex.slice(0 + count * 2, 2 + count * 2));
      if (count === 0) {
        value = Big(((byte & 63) * (128 ** count))).add(value);
      } else {
        value = Big(((byte & 127) * 2) >> 1).times(64 * 128 ** (count - 1)).add(value);
      }
      count++;
      if ((byte & 128) !== 128) {
        break;
      }
    }
    return {
      value: value,
      count: count
    };
  }
  getContractDelegation(pkh: string) {
    return {
      entrypoint: 'do',
      value:
        [{ prim: 'DROP' },
        {
          prim: 'NIL',
          args: [{ prim: 'operation' }]
        },
        {
          prim: 'PUSH',
          args:
            [{ prim: 'key_hash' },
            {
              string: pkh
            }]
        },
        { prim: 'SOME' }, { prim: 'SET_DELEGATE' },
        { prim: 'CONS' }]
    };
  }
  getContractUnDelegation() {
    return {
      entrypoint: 'do',
      value:
        [{ prim: 'DROP' },
        {
          prim: 'NIL',
          args: [{ prim: 'operation' }],
        }, {
          prim: 'NONE',
          args: [{ prim: 'key_hash' }],
        },
        { prim: 'SET_DELEGATE' },
        { prim: 'CONS' }]
    };
  }
  getContractPkhTransaction(to: string, amount: string) {
    return {
      entrypoint: 'do',
      value:
        [{ prim: 'DROP' },
        { prim: 'NIL', args: [{ prim: 'operation' }] },
        {
          prim: 'PUSH',
          args:
            [{ prim: 'key_hash' },
            {
              string: to
            }]
        },
        { prim: 'IMPLICIT_ACCOUNT' },
        {
          prim: 'PUSH',
          args:
            [{ prim: 'mutez' }, { 'int': amount }]
        },
        { prim: 'UNIT' }, { prim: 'TRANSFER_TOKENS' },
        { prim: 'CONS' }]
    };
  }
  getContractKtTransaction(to: string, amount: string) {
    return {
      entrypoint: 'do',
      value: [{ prim: 'DROP' },
      { prim: 'NIL', args: [{ prim: 'operation' }] },
      {
        prim: 'PUSH',
        args:
          [{ prim: 'address' },
          { string: to }]
      },
      { prim: 'CONTRACT', args: [{ prim: 'unit' }] },
      [{
        prim: 'IF_NONE',
        args:
          [[[{ prim: 'UNIT' }, { prim: 'FAILWITH' }]],
          []]
      }],
      {
        prim: 'PUSH',
        args: [{ prim: 'mutez' }, { 'int': amount }]
      },
      { prim: 'UNIT' }, { prim: 'TRANSFER_TOKENS' },
      { prim: 'CONS' }]
    };
  }
  getManagerScript(pkh: string) {
    let pkHex: string;
    if (pkh.slice(0, 2) === 'tz') {
      pkHex = '00' + this.buf2hex(this.b58cdecode(pkh, this.prefix.tz1));
    } else {
      pkHex = pkh;
    }
    return {
      code: [
        {
          prim: 'parameter',
          args: [
            {
              prim: 'or',
              args: [
                {
                  prim: 'lambda',
                  args: [
                    {
                      prim: 'unit'
                    },
                    {
                      prim: 'list',
                      args: [
                        {
                          prim: 'operation'
                        }
                      ]
                    }
                  ],
                  annots: [
                    '%do'
                  ]
                },
                {
                  prim: 'unit',
                  annots: [
                    '%default'
                  ]
                }
              ]
            }
          ]
        },
        {
          prim: 'storage',
          args: [
            {
              prim: 'key_hash'
            }
          ]
        },
        {
          prim: 'code',
          args: [
            [
              [
                [
                  {
                    prim: 'DUP'
                  },
                  {
                    prim: 'CAR'
                  },
                  {
                    prim: 'DIP',
                    args: [
                      [
                        {
                          prim: 'CDR'
                        }
                      ]
                    ]
                  }
                ]
              ],
              {
                prim: 'IF_LEFT',
                args: [
                  [
                    {
                      prim: 'PUSH',
                      args: [
                        {
                          prim: 'mutez'
                        },
                        {
                          'int': '0'
                        }
                      ]
                    },
                    {
                      prim: 'AMOUNT'
                    },
                    [
                      [
                        {
                          prim: 'COMPARE'
                        },
                        {
                          prim: 'EQ'
                        }
                      ],
                      {
                        prim: 'IF',
                        args: [
                          [

                          ],
                          [
                            [
                              {
                                prim: 'UNIT'
                              },
                              {
                                prim: 'FAILWITH'
                              }
                            ]
                          ]
                        ]
                      }
                    ],
                    [
                      {
                        prim: 'DIP',
                        args: [
                          [
                            {
                              prim: 'DUP'
                            }
                          ]
                        ]
                      },
                      {
                        prim: 'SWAP'
                      }
                    ],
                    {
                      prim: 'IMPLICIT_ACCOUNT'
                    },
                    {
                      prim: 'ADDRESS'
                    },
                    {
                      prim: 'SENDER'
                    },
                    [
                      [
                        {
                          prim: 'COMPARE'
                        },
                        {
                          prim: 'EQ'
                        }
                      ],
                      {
                        prim: 'IF',
                        args: [
                          [

                          ],
                          [
                            [
                              {
                                prim: 'UNIT'
                              },
                              {
                                prim: 'FAILWITH'
                              }
                            ]
                          ]
                        ]
                      }
                    ],
                    {
                      prim: 'UNIT'
                    },
                    {
                      prim: 'EXEC'
                    },
                    {
                      prim: 'PAIR'
                    }
                  ],
                  [
                    {
                      prim: 'DROP'
                    },
                    {
                      prim: 'NIL',
                      args: [
                        {
                          prim: 'operation'
                        }
                      ]
                    },
                    {
                      prim: 'PAIR'
                    }
                  ]
                ]
              }
            ]
          ]
        }
      ],
      storage:
        { bytes: pkHex }
    };
  }
  getFA12Transaction(from: string, to: string, amount: string) {
    return {
      entrypoint: 'transfer',
      value: {
        args: [
          {
            string: from
          }, {
            args: [
              {
                string: to
              }, {
                int: amount
              }
            ],
            prim: 'Pair'
          }
        ],
        prim: 'Pair'
      }
    };
  }
  getFA2Transaction(from: string, to: string, amount: string, id: number) {
    return {
      entrypoint: 'transfer',
      value: [
        {
          prim: 'Pair',
          args: [
            {
              string: from
            },
            [
              {
                prim: 'Pair',
                args: [
                  {
                    string: to
                  },
                  {
                    prim: 'Pair',
                    args: [
                      {
                        'int': id.toString()
                      },
                      {
                        'int': amount
                      }
                    ]
                  }
                ]
              }
            ]
          ]
        }
      ]
    };
  }
  parseTokenTransfer(op: any): { tokenId: string, to: string, amount: string } {
    const opJson = JSON.stringify(op.parameters);
    const addresses = opJson.match(/(?<={\"string\":\")[^\"]*/g);
    const amounts = opJson.match(/(?<={\"int\":\")[^\"]*/g);
    if (addresses.length === 2) {
      if (amounts.length === 1) {
        const fa12ref = this.getFA12Transaction(addresses[0], addresses[1], amounts[0]);
        if (isEqual(fa12ref, op.parameters)) {
          return { tokenId: `${op.destination}:0`, to: addresses[1], amount: amounts[0] };
        }
      } else if (amounts.length === 2) {
        const fa2ref = this.getFA2Transaction(addresses[0], addresses[1], amounts[1], Number(amounts[0]));
        if (isEqual(fa2ref, op.parameters)) {
          return { tokenId: `${op.destination}:${amounts[0]}`, to: addresses[1], amount: amounts[1] };
        }
      }
    }
    return null;
  }
}
