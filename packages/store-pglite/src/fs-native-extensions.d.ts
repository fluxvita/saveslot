// The part of fs-native-extensions (Apache-2.0, ships prebuilt binaries) that lock.ts uses.
declare module "fs-native-extensions" {
  const fsx: {
    /** Exclusive non-blocking lock on the whole file; false when another holder has it. */
    tryLock(fd: number, opts?: { shared?: boolean }): boolean;
    unlock(fd: number): void;
  };
  export default fsx;
}
