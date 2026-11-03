/** Retry recovery after an interrupted install or a storage failure. */
export declare function recoverRepository(): Promise<void>;
/** Download and back up before touching the live checkout. Browser storage has
 * no atomic directory swap; retain a complete recovery copy even after success.
 * Failed installs roll back. If storage also prevents rollback, the backup stays
 * available in the independent siglum-git-recovery storage namespace.
 */
export declare function replaceRepository(clone: (directory: string) => Promise<void>, beforeReplace?: () => Promise<void>): Promise<void>;
//# sourceMappingURL=RepositoryReplacement.d.ts.map