window.appApi.onAnswerUpdate(({ text }) => {
  document.getElementById('answer').textContent = text;
});
