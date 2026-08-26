const ASSERT_THROWS = /\bassert(?:\s*\.\s*strict)?\s*\.\s*throws\s*\(/;
const TEST_PATH = /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|(?:\.test|\.spec)\.[cm]?[jt]sx?$/i;

export function asyncAssertionGuard(action, observation = "") {
  if (!editSucceeded(observation)) return "";
  const edits = actionEdits(action);
  if (!edits.some(({ path, text }) => TEST_PATH.test(path) && ASSERT_THROWS.test(text))) {
    return "";
  }
  return "\n[async-test guard] This test introduced `assert.throws`. Confirm the subject throws synchronously. If it is `async` or returns a Promise, use `await assert.rejects(...)` and preserve the API's rejection timing; do not make production code throw synchronously to satisfy this probe.";
}

function actionEdits(action = {}) {
  if (action.a === "write_file") return [{ path: String(action.p ?? ""), text: String(action.content ?? "") }];
  if (action.a === "write_batch" && Array.isArray(action.files)) {
    return action.files.map((file) => ({
      path: String(file?.p ?? ""),
      text: String(file?.content ?? ""),
    }));
  }
  if (action.a === "replace" || action.a === "edit_lines") {
    return [{ path: String(action.p ?? ""), text: String(action.new ?? "") }];
  }
  if (action.a === "patch" && Array.isArray(action.edits)) {
    return action.edits.map((edit) => ({
      path: String(edit?.p ?? ""),
      text: String(edit?.new ?? ""),
    }));
  }
  return [];
}

function editSucceeded(observation) {
  const text = String(observation ?? "");
  return !/^(?:ERROR:|BLOCKED:)|failed|not found|did not match/i.test(text.trim());
}
