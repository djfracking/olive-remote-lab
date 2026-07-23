const form = document.querySelector("#support-form");
const status = document.querySelector("#support-status");
const startedAt = document.querySelector("#support-started-at");

function resetStartedAt() {
  startedAt.value = String(Date.now());
}

resetStartedAt();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button[type='submit']");
  const data = Object.fromEntries(new FormData(form).entries());
  button.disabled = true;
  status.className = "";
  status.textContent = "Sending…";

  try {
    const response = await fetch("/api/support", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Support request could not be sent.");
    form.reset();
    resetStartedAt();
    status.className = "success";
    status.textContent = result.dryRun
      ? "Dry run accepted by the local emulator. No email was sent."
      : "Your support request was sent. We’ll reply by email.";
  } catch (error) {
    status.className = "error";
    status.textContent = error instanceof Error ? error.message : "Support request could not be sent.";
  } finally {
    button.disabled = false;
  }
});
