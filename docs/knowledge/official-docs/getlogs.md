# Get the runtime logs


> 来源：https://kbengine.github.io/docs/documentations/getlogs.html

Get the runtime logs

###There are two ways to view the server running log:

Use visualization console tool GUIConsole, must be open logger Service.

View log files(KBE_BIN_PATH/logs/xxx.log).

Note: if the logger service is started, then the logs will be forwarded to the logger process, logger process will logs write “logger_.*.log". Start logger, you can modify the startup script or modify tools start-layout. https://kbengine.github.io//cn/docs/startup_shutdown.html

###Log types:

DEBUG		: Debug Log
WARRING		: Warning log
ERROR		: Error Log
INFO		: general log
S_DBG		: Script-layer debug log
S_ERR		: Script-layer error log
S_INFO		: Script-layer general log
