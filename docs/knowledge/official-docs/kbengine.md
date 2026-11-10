# kbengine.xml


> 来源：https://kbengine.github.io/docs/configuration/kbengine.html

Server Configuration(assets/res/server/kbengine.xml)

If you need to change the configuration of the engine, as long as the inheritance ({assets}/res/server/kbengine.xml) this configuration file and overwrite the corresponding section kbe/res/server/kbengine_defaults.xml, but doing so will not damage the engine settings, there is no conflict in the development along with updated engine or multiple projects.

###Overloaded default configuration examples:

```xml
<root>
	<trace_packet>
		<debug_type>0</debug_type>
	</trace_packet>
```

```xml
	<app_publish>0</app_publish>

	<!-- defined => kbe/res/server/kbengine_defaults.xml -->
	<dbmgr>
		<databaseInterfaces>
			<default>
				<host> localhost </host>
				<databaseName> kbe </databaseName>
			</default>
		</databaseInterfaces>
	</dbmgr>
</root>
```
