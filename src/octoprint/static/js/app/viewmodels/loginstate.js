$(function() {
    function LoginStateViewModel() {
        var self = this;

        self.loginUser = ko.observable("");
        self.loginPass = ko.observable("");
        self.loginRemember = ko.observable(false);

        self.loggedIn = ko.observable(false);
        self.username = ko.observable(undefined);
        self.isAdmin = ko.observable(false);
        self.isUser = ko.observable(false);

        self.allViewModels = undefined;

        self.currentUser = ko.observable(undefined);

        self.elementUsernameInput = undefined;
        self.elementPasswordInput = undefined;
        self.elementLoginButton = undefined;

        self.userMenuText = ko.pureComputed(function() {
            if (self.loggedIn()) {
                return self.username();
            } else {
                return gettext("Login");
            }
        });

        self.reloadUser = function() {
            if (self.currentUser() == undefined) {
                return;
            }

            OctoPrint.users.get(self.currentUser().name)
                .done(self.fromResponse);
        };

        self.requestData = function() {
            OctoPrint.browser.passiveLogin()
                .done(self.fromResponse);
        };

        self.fromResponse = function(response) {
            if (response && response.name) {
                self.loggedIn(true);
                self.username(response.name);
                self.isUser(response.user);
                self.isAdmin(response.admin);

                self.currentUser(response);

                callViewModels(self.allViewModels, "onUserLoggedIn", [response]);

                //Reactivates workbench keyboard shortcuts
                BEEwb.main.activateWorkbenchKeys();
            } else {
                self.loggedIn(false);
                self.username(undefined);
                self.isUser(false);
                self.isAdmin(false);

                self.currentUser(undefined);

                callViewModels(self.allViewModels, "onUserLoggedOut");

                // Shows the login dialog modal if no session is active
                if (!CONFIG_FIRST_RUN) {
                    var dialog = $('#login_dialog');
                    self.showLoginDialog(dialog);
                }

                // Deactivates the workbench keyboard shortcuts to prevent actions being trigger when user is typing
                BEEwb.main.deactivateWorkbenchKeys();
            }
        };

        self.login = function(u, p, r) {
            var username = u || self.loginUser();
            var password = p || self.loginPass();
            var remember = (r != undefined ? r : self.loginRemember());

            return OctoPrint.browser.login(username, password, remember)
                .done(function(response) {
                    new PNotify({title: gettext("Login successful"), text: _.sprintf(gettext('You are now logged in as "%(username)s"'), {username: response.name}), type: "success"});
                    self.fromResponse(response);

                    self.loginUser("");
                    self.loginPass("");
                    self.loginRemember(false);

                    // Hides the login modal in case is opened
                    $("#login_dialog").modal('hide');

                })
                .fail(function() {
                    new PNotify({title: gettext("Login failed"), text: gettext("User unknown or wrong password"), type: "error"});
                });
        };

        self.logout = function() {
            OctoPrint.browser.logout()
                .done(function(response) {
                    new PNotify({title: gettext("Logout successful"), text: gettext("You are now logged out"), type: "success"});
                    self.fromResponse(response);
                })
                .error(function(error) {
                    if (error && error.status === 401) {
                         self.fromResponse(false);
                    }
                });
        };

        self.onLoginUserKeyup = function(data, event) {
            if (event.keyCode == 13) {
                self.elementPasswordInput.focus();
            }
        };

        self.onLoginPassKeyup = function(data, event) {
            if (event.keyCode == 13) {
                self.login();
            }
        };

        self.onAllBound = function(allViewModels) {
            self.allViewModels = allViewModels;
        };

        self.onStartupComplete = self.onServerConnect = self.onServerReconnect = function() {
            if (self.allViewModels == undefined) return;
            self.requestData();
        };

        self.onStartup = function() {
            self.elementUsernameInput = $("#login_user");
            self.elementPasswordInput = $("#login_pass");
            self.elementLoginButton = $("#login_button");
            if (self.elementUsernameInput && self.elementUsernameInput.length
                && self.elementLoginButton && self.elementLoginButton.length) {
                self.elementLoginButton.blur(function() {
                    self.elementUsernameInput.focus();
                })
            }
        };

        self.showLoginDialog = function(loginDialog) {

            // shows login modal, ensures centered position
            loginDialog.modal({
                minHeight: function() { return Math.max($.fn.modal.defaults.maxHeight() - 500, 250); }
            }).css({
                width: '50%',
                'margin-left': function() { return -($(this).width() /2); }
            });

            return false;
        };
    }

    OCTOPRINT_VIEWMODELS.push([
        LoginStateViewModel,
        [],
        ["#login_form_body"]
    ]);
});
