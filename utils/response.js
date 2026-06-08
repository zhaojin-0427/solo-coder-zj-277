function success(data, message = '操作成功') {
  return {
    code: 0,
    message,
    data
  };
}

function error(message = '操作失败', code = -1, data = null) {
  return {
    code,
    message,
    data
  };
}

function badRequest(message = '请求参数错误', data = null) {
  return error(message, 400, data);
}

function notFound(message = '资源不存在', data = null) {
  return error(message, 404, data);
}

module.exports = {
  success,
  error,
  badRequest,
  notFound
};
