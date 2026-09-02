import type { StyleProp, ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";

/**
 * Daseo-local subset of upstream Paseo's `icon-button-chrome` helper. Upstream
 * introduced it with the Explorer pane-host rework (#3826), which Daseo does not
 * carry; the zoomable-viewport toolbar (#4032/#4049) is the only consumer here.
 * Only the "small" icon-button chrome the toolbar needs is implemented.
 */
export type IconButtonChromeSize = "small";

const SMALL_ICON_BUTTON_SIZE = 20;
const COMPACT_SMALL_ICON_BUTTON_SIZE = 32;
const SMALL_GLYPH_SIZE = 14;
const COMPACT_SMALL_GLYPH_SIZE = 18;

export interface IconButtonChromeState {
  hovered?: boolean;
  pressed?: boolean;
  open?: boolean;
  active?: boolean;
}

interface IconButtonChromeOptions {
  size: IconButtonChromeSize;
  state?: IconButtonChromeState;
  compact?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

/** Shared hitbox and interaction chrome for icon-only toolbar controls. */
export function iconButtonChromeStyle({
  state,
  compact = false,
  disabled = false,
  style,
}: IconButtonChromeOptions): StyleProp<ViewStyle> {
  const highlighted = state?.active || state?.hovered || state?.pressed || state?.open;
  return [
    compact ? styles.smallCompact : styles.small,
    style,
    highlighted ? styles.highlighted : null,
    disabled ? styles.disabled : null,
  ];
}

export function iconButtonChromeGlyphSize(_size: IconButtonChromeSize, compact = false): number {
  return compact ? COMPACT_SMALL_GLYPH_SIZE : SMALL_GLYPH_SIZE;
}

const styles = StyleSheet.create((theme) => ({
  small: {
    width: SMALL_ICON_BUTTON_SIZE,
    height: SMALL_ICON_BUTTON_SIZE,
    padding: 0,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    outlineWidth: 0,
    outlineColor: "transparent",
  },
  smallCompact: {
    width: COMPACT_SMALL_ICON_BUTTON_SIZE,
    height: COMPACT_SMALL_ICON_BUTTON_SIZE,
    padding: 0,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    outlineWidth: 0,
    outlineColor: "transparent",
  },
  highlighted: {
    backgroundColor: theme.colors.surface3,
  },
  disabled: {
    opacity: theme.opacity[50],
  },
}));
