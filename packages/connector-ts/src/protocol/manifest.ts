// The connector protocol: how a connector describes itself.

/**
 * Where a connector runs. A fixed set: the object is frozen. Only `cloud` (a program that reaches
 * the service where it runs) works with the local service today; a connector on a device needs
 * server mode, which comes later (01-positioning).
 */
export const ConnectorPlatform = Object.freeze({
  /** A server, a script or a cloud function. */
  Cloud: "cloud",
  /** A native iOS app. Needs server mode. */
  IOS: "ios",
  /** A native Android app. Needs server mode. */
  Android: "android",
  /** A Flutter app. Needs server mode. */
  Flutter: "flutter",
  /** A React Native app. Needs server mode. */
  ReactNative: "react_native",
} as const);

/** One of `ConnectorPlatform`'s values. */
export type ConnectorPlatform = (typeof ConnectorPlatform)[keyof typeof ConnectorPlatform];

/** Every platform, in a fixed order. */
export const CONNECTOR_PLATFORMS: readonly ConnectorPlatform[] = Object.freeze(
  Object.values(ConnectorPlatform),
);

/** A connector's description of itself: what users see when they choose and connect it. */
export interface ConnectorManifest {
  /** Unique identifier, e.g. `"com.example.mail"`. */
  readonly id: string;
  /** Display name, e.g. `"Mail"`. */
  readonly name: string;
  /** A short description of what it collects. */
  readonly description: string;
  /** The logo: a URL, or a `data:` URI of the image. */
  readonly logo: string;
  /** Version, e.g. `"1.0.0"`. */
  readonly version: string;
  /** Who publishes it. */
  readonly publisher: string;
  /** Where it runs: one platform or several, e.g. `[ConnectorPlatform.Cloud]`. */
  readonly platforms: readonly ConnectorPlatform[];
  /**
   * The package address of each platform listed, except `cloud`: a package name or an app-store
   * address, e.g. `{ ios: "https://apps.apple.com/app/id000", android: "com.example.mail" }`.
   */
  readonly packages?: Readonly<Partial<Record<Exclude<ConnectorPlatform, "cloud">, string>>>;
  /** Homepage or documentation. */
  readonly homepage?: string;
}
