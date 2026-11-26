import { generateReport, listReports } from './report.js';
import { projectSettings } from './project-admin.js';
import { appendEvent } from './run.js';

/**
 * 运行进入终态后的默认动作：生成报告版本。
 * - autoReport=false 时跳过；
 * - autoExport=false 时仍生成可预览版本，只是不写入 exports/reports；
 * - 同一 Run 已有报告则不重复生成（重生成需显式调用 report generate）。
 */
export function finalizeRunArtifacts(ctx, runId) {
  const settings = projectSettings(ctx);
  if (!settings.autoReport) return { generated: false, reason: 'disabled', settings };
  const existing = listReports(ctx, runId);
  if (existing.length) return { generated: false, reason: 'exists', reportId: existing[0].reportId, settings };
  try {
    const report = generateReport(ctx, runId, { exportToExports: settings.autoExport });
    appendEvent(ctx, runId, 'report_generated', {
      reportId: report.reportId,
      auto: true,
      exported: report.exported,
      path: report.path,
    });
    return { generated: true, reportId: report.reportId, path: report.path, exported: report.exported, settings };
  } catch (error) {
    appendEvent(ctx, runId, 'report_failed', {
      auto: true,
      code: error.code ?? 'INTERNAL_UNEXPECTED',
      message: error.message,
    });
    return { generated: false, reason: 'error', error: { code: error.code ?? 'INTERNAL_UNEXPECTED', message: error.message }, settings };
  }
}
