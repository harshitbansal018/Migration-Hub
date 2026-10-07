/* app.js — behaviour shared by every screen.
 *
 * Any element with data-post="/url" becomes an action button:
 *
 *   <button data-post="/migrations/12/control"
 *           data-body='{"action":"pause"}'
 *           data-confirm="Pause this migration?\n\nIt stops after the current page."
 *           data-confirm-label="Pause"
 *           data-destructive
 *           data-then="/migrations/12">Pause</button>
 *
 * It asks the question (the admin's own dialog), spins while the request
 * runs, shows the server's error in #page-error (or a toast), and on success
 * goes to data-then -- or to the `url` the server answered with, or reloads.
 */
(function () {
  function pageError(message) {
    var box = document.getElementById("page-error");
    if (!box) return window.appToast(message, true);
    var text = box.querySelector("[data-error-text]") || box;
    text.textContent = message;
    box.hidden = false;
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function clearError() {
    var box = document.getElementById("page-error");
    if (box) box.hidden = true;
  }

  async function postJson(url, body, busy) {
    var response = await window.appFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      busy: busy,
    });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok || data.ok === false) {
      var error = new Error(data.error || "Something went wrong. Try again.");
      error.data = data;
      throw error;
    }
    return data;
  }

  document.addEventListener("click", async function (event) {
    var button = event.target.closest("[data-post]");
    if (!button || button.disabled) return;
    event.preventDefault();
    clearError();

    var message = button.getAttribute("data-confirm");
    if (message) {
      var yes = await window.appConfirm(message.replace(/\\n/g, "\n"), {
        confirmLabel: button.getAttribute("data-confirm-label") || "Confirm",
        destructive: button.hasAttribute("data-destructive"),
      });
      if (!yes) return;
    }

    try {
      var body = button.getAttribute("data-body");
      var data = await postJson(button.getAttribute("data-post"), body ? JSON.parse(body) : {}, button);
      var toast = button.getAttribute("data-toast");
      if (toast) window.appToast(toast);
      var then = button.getAttribute("data-then") || data.url;
      if (!then) {
        // Back to this screen, minus the old (single-use) session token.
        var here = new URL(window.location.href);
        here.searchParams.delete("id_token");
        then = here.pathname + here.search;
      }
      window.appNavigate(then);
    } catch (error) {
      if (error.data && error.data.upgrade) {
        pageError(error.message + " Open Plans to upgrade.");
      } else {
        pageError(error.message);
      }
    }
  });

  /* Copy-to-clipboard and show/hide for secret fields. */
  document.addEventListener("click", function (event) {
    var toggle = event.target.closest("[data-reveal]");
    if (!toggle) return;
    var input = document.getElementById(toggle.getAttribute("data-reveal"));
    if (!input) return;
    var show = input.type === "password";
    input.type = show ? "text" : "password";
    toggle.textContent = show ? "Hide" : "Show";
  });

  /* Rows that open something: keyboard too, not only the mouse. */
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    var row = event.target.closest("tr[data-navigate], [role=link][data-navigate]");
    if (!row || event.target !== row) return;
    event.preventDefault();
    window.appNavigate(row.getAttribute("data-navigate"));
  });

  window.appPostJson = postJson;
  window.appPageError = pageError;
  window.appClearError = clearError;
})();
