import { default as React } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";

/**
 * Shown in the history-start slot when the page before the oldest loaded row could
 * not be read. Without it a failed page silently re-requests itself every time the
 * reader returns to the top of the transcript.
 */
export function OlderHistoryErrorRow({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.row} testID="load-older-history-error">
      <Text style={styles.message} numberOfLines={1}>
        {t("loadOlderHistory.failed")}
      </Text>
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel={t("common.actions.retry")}
        hitSlop={8}
        testID="load-older-history-retry"
      >
        <Text style={styles.retry}>{t("common.actions.retry")}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
  },
  message: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  retry: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: "600",
  },
}));
