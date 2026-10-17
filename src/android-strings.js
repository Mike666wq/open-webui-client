export function androidStrings(isAndroid, language = 'en') {
  if (!isAndroid || !language.toLowerCase().startsWith('zh')) return null;
  return {
    heading: '连接到服务', connectingHeading: '正在连接服务',
    detail: '输入你的 Open WebUI 服务地址。', connectingDetail: '正在打开服务并检查 Open WebUI 是否就绪…',
    label: '服务地址', connect: '连接', connecting: '正在连接…',
    invalidAddress: '请输入有效的 HTTP(S) 服务地址，不含账号密码或子路径。',
    failure: '连接失败，请检查地址和网络后重试。', settingsFailure: '无法读取连接设置，请重试。',
    diagnostics: '导出安卓诊断（不会自动发送）',
    choose: '请选择诊断报告的保存位置，报告不会自动发送。',
    exported: '诊断报告已保存到本地，未发送。', cancelled: '已取消导出，未发送报告。',
    exportFailure: '无法导出安卓诊断，未发送报告。',
  };
}
