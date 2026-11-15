// Platform edge for link prefetch: NetInfo and React Native's InteractionManager behind the core's
// ports. The policy and the use case are in src/utils/prefetchPolicy.ts and src/core/prefetch.ts;
// the composition root puts them together.
import { InteractionManager } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import type { Connectivity, Interactions } from '../core/ports';

export const netInfoConnectivity: Connectivity = {
  async current() {
    const net = await NetInfo.fetch();
    return {
      isConnected: net.isConnected,
      isInternetReachable: net.isInternetReachable,
      isExpensive: (net.details as { isConnectionExpensive?: boolean } | null)?.isConnectionExpensive ?? null,
    };
  },
};

export const rnInteractions: Interactions = {
  afterInteractions: cb => InteractionManager.runAfterInteractions(cb),
};
