function buildPayload(code, message, data) {
  return { code, message, data };
}

function send(res, httpStatus, code, message, data) {
  if (res && res.status && res.json) {
    return res.status(httpStatus).json(buildPayload(code, message, data));
  }
  return buildPayload(code, message, data);
}

function success(data, message = '操作成功', res) {
  return send(res, 200, 0, message, data);
}

function error(message = '操作失败', code = -1, data = null, res) {
  const httpStatus = (code >= 400 && code < 600) ? code : 500;
  return send(res, httpStatus, code, message, data);
}

function badRequest(message = '请求参数错误', data = null, res) {
  return send(res, 400, 400, message, data);
}

function notFound(message = '资源不存在', data = null, res) {
  return send(res, 404, 404, message, data);
}

module.exports = {
  success,
  error,
  badRequest,
  notFound
};
