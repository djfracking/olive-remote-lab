(() => {
  "use strict";

  const form = document.querySelector("#diagnostic-form");
  const panels = Array.from(document.querySelectorAll("[data-diagnostic-step]"));
  const progressItems = Array.from(document.querySelectorAll("[data-progress-step]"));
  const status = document.querySelector("#diagnostic-status");
  const startedAt = document.querySelector("#diagnostic-started-at");
  const completion = document.querySelector("#diagnostic-complete");
  const submitButton = form?.querySelector("button[type='submit']");
  let activeStep = 0;

  if (!form || !panels.length || !status || !startedAt || !submitButton) return;

  function resetStartedAt() {
    startedAt.value = String(Date.now());
  }

  function showStep(nextStep, focusHeading = false) {
    activeStep = Math.max(0, Math.min(nextStep, panels.length - 1));
    panels.forEach((panel, index) => {
      const active = index === activeStep;
      panel.hidden = !active;
      panel.setAttribute("aria-hidden", String(!active));
    });
    progressItems.forEach((item, index) => {
      if (index === activeStep) item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
    });
    if (focusHeading) {
      panels[activeStep]?.scrollIntoView({ behavior: "smooth", block: "start" });
      panels[activeStep]?.querySelector("h2")?.focus({ preventScroll: true });
    }
  }

  function currentStepIsValid() {
    const requiredFields = Array.from(panels[activeStep].querySelectorAll("input[required], select[required], textarea[required]"));
    for (const field of requiredFields) {
      if (!field.checkValidity()) {
        field.reportValidity();
        field.focus();
        return false;
      }
    }
    return true;
  }

  form.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-step-action]");
    if (!button) return;
    const action = button.dataset.stepAction;
    if (action === "next" && currentStepIsValid()) showStep(activeStep + 1, true);
    if (action === "back") showStep(activeStep - 1, true);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    const data = new FormData(form);
    const payload = {
      requestType: "diagnostic",
      startedAt: data.get("startedAt"),
      website: data.get("website") || "",
      email: data.get("email") || "",
      model: data.get("model") || "unknown",
      firmware: data.get("firmware") || "",
      bootState: data.get("bootState") || "unknown",
      networkVisibility: data.get("networkVisibility") || "not-checked",
      issue: data.get("issue") || "other",
      country: data.get("country") || "",
      details: data.get("details") || "",
      consent: data.get("consent") === "on",
      releaseConsent: data.get("releaseConsent") === "on",
      source: data.get("source") || "direct",
    };

    submitButton.disabled = true;
    status.className = "diagnostic-status";
    status.textContent = "Sending your diagnostic…";

    try {
      const response = await fetch("/api/support", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Your diagnostic could not be sent.");
      form.reset();
      resetStartedAt();
      panels.forEach((panel) => { panel.hidden = true; });
      completion?.removeAttribute("hidden");
      progressItems.forEach((item) => item.removeAttribute("aria-current"));
      status.className = "diagnostic-status success";
      if (result.dryRun) {
        const completionHeading = completion?.querySelector("h2");
        const completionMessage = completion?.querySelector("p");
        if (completionHeading) completionHeading.textContent = "Dry run complete.";
        if (completionMessage) completionMessage.textContent = "The local emulator validated this diagnostic. No email or production secret was used.";
        status.textContent = "Dry run accepted. No email was sent.";
      } else {
        status.textContent = "Sent. We’ll review the device state and reply by email.";
      }
      status.focus();
    } catch (error) {
      status.className = "diagnostic-status error";
      status.textContent = error instanceof Error ? error.message : "Your diagnostic could not be sent.";
      status.focus();
    } finally {
      submitButton.disabled = false;
    }
  });

  resetStartedAt();
  showStep(0);
})();
