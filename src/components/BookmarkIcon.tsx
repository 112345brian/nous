import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { colors } from '../theme/tokens';

interface Props {
  active: boolean;
  size?: number;
}

export default function BookmarkIcon({ active, size = 22 }: Props) {
  const color = active ? colors.danger : colors.textMuted;
  const w = size * 0.65;
  const h = size;
  // Ribbon bookmark: rectangle with a pointed V notch at the bottom
  // viewBox 0 0 13 18
  return (
    <Svg width={w} height={h} viewBox="0 0 13 18" fill="none">
      <Path
        d="M1 1h11v16l-5.5-4L1 17V1z"
        fill={active ? colors.danger : 'none'}
        stroke={color}
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
    </Svg>
  );
}
