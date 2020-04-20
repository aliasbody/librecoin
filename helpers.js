module.exports = {
  // Return a value by adding a given percentage
  addPercent: function (value, percent) {
    return value * ((percent/100) + 1);
  },

  // Return a value by subtracting a percentage
  subPercent: function (value, percent) {
    return -(((value * percent) / 100) - value);
  }
};
